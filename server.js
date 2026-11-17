const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const fs = require('fs');
const path = require('path');

const PORT = 8888;
const ADMIN_KEY = "admin123"; // Clave de administrador
const CONFIG_FILE = path.join(__dirname, 'config.json');

// Cargar o inicializar configuración persistente
let config = {
  transmissionMode: 'blocked' // 'blocked' (Semidúplex), 'free' (Libre), 'conference' (Conferencia)
};

try {
  if (fs.existsSync(CONFIG_FILE)) {
    const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    config = { ...config, ...saved };
  } else {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
  }
} catch (e) {
  console.error("Error cargando config.json:", e.message);
}

// Canales en memoria y oradores
const channels = new Map(); // channelName -> Set of sockets
const channelSpeakers = new Map(); // channelName -> uid

const server = http.createServer((req, res) => {
  // Desactivar Nagle a nivel HTTP para respuesta instantánea
  if (req.socket) req.socket.setNoDelay(true);

  // Endpoint: Cambiar Política de Transmisión
  if (req.method === 'POST' && req.url === '/api/set-mode') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (data.key !== ADMIN_KEY) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Clave de administrador incorrecta' }));
        }

        const validModes = ['blocked', 'free', 'conference'];
        if (!validModes.includes(data.mode)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Modo no válido' }));
        }

        config.transmissionMode = data.mode;
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');

        // Notificar a todos los radios conectados
        broadcastAll({
          type: 'policy_updated',
          mode: config.transmissionMode
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          mode: config.transmissionMode,
          message: `Modo de transmisión actualizado a: ${config.transmissionMode}`
        }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Endpoint: Eliminar Canal
  if (req.method === 'POST' && req.url === '/api/delete-channel') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (data.key !== ADMIN_KEY) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Clave de administrador incorrecta' }));
        }

        const channelToDelete = data.channel;
        if (!channelToDelete || channelToDelete === 'Canal 1 (General)') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'No se puede eliminar el canal principal' }));
        }

        const clients = channels.get(channelToDelete);
        if (clients) {
          for (const ws of clients) {
            joinChannel(ws, 'Canal 1 (General)', ws.uid || 0);
            ws.send(JSON.stringify({
              type: 'channel_deleted',
              channel: channelToDelete,
              message: 'El canal fue eliminado por el administrador. Regresaste a Canal 1.'
            }));
          }
          channels.delete(channelToDelete);
        }
        channelSpeakers.delete(channelToDelete);

        broadcastAll({ type: 'channel_created' });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: `Canal ${channelToDelete} eliminado con éxito` }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Panel Web visual de estado en https://radio.cire-unah.site
  if (req.url === '/' || req.url === '/status') {
    const totalUsers = Array.from(channels.values()).reduce((acc, set) => acc + set.size, 0);
    const channelListHtml = Array.from(channels.entries()).map(([name, set]) => {
      const speaker = channelSpeakers.get(name);
      const isGeneral = name === 'Canal 1 (General)';
      return `
        <div style="background:#1e293b; padding:14px 18px; border-radius:10px; margin-bottom:10px; border-left:5px solid ${speaker ? '#ef4444' : '#10b981'}; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
          <div>
            <div style="font-size:1.1rem; font-weight:bold; color:#f8fafc;">📻 ${name}</div>
            <div style="color:#94a3b8; font-size:0.85rem; margin-top:3px;">
              Radios en canal: <span style="color:#38bdf8; font-weight:bold;">${set.size}</span>
              ${speaker ? `<span style="background:#dc2626; color:#fff; padding:2px 8px; border-radius:12px; margin-left:10px; font-size:0.75rem; font-weight:bold;">HABLANDO: UID ${speaker}</span>` : `<span style="background:#15803d; color:#fff; padding:2px 8px; border-radius:12px; margin-left:10px; font-size:0.75rem;">Canal Libre</span>`}
            </div>
          </div>
          ${!isGeneral ? `
            <button onclick="eliminarCanal('${name}')" style="background:#dc2626; color:#fff; border:none; padding:7px 12px; border-radius:6px; cursor:pointer; font-weight:600; font-size:0.8rem;">
              🗑️ Eliminar
            </button>
          ` : `<span style="color:#64748b; font-size:0.8rem; font-style:italic;">Canal Fijo</span>`}
        </div>
      `;
    }).join('') || '<div style="color:#94a3b8; text-align:center; padding:15px; background:#1e293b; border-radius:8px;">No hay canales en memoria todavía.</div>';

    const modeLabels = {
      'blocked': '🔒 Modo 1: Radio Profesional (Bloqueo de Canal Ocupado)',
      'free': '🔓 Modo 2: Modo Libre (Sin Restricciones)',
      'conference': '👥 Modo 3: Modo Conferencia (Múltiples Oradores)'
    };

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`
      <!DOCTYPE html>
      <html lang="es">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Volkee - Panel Central PTT</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; margin: 0; padding: 20px; }
          .container { max-width: 760px; margin: 0 auto; }
          .card { background: #1e293b; border-radius: 12px; padding: 20px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.3); margin-bottom: 20px; }
          .badge { display: inline-block; padding: 4px 10px; border-radius: 9999px; font-size: 0.85rem; font-weight: 600; background: #10b981; color: #fff; }
          .stat-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin: 15px 0; }
          .stat-box { background: #0f172a; padding: 15px; border-radius: 8px; text-align: center; }
          .stat-num { font-size: 2rem; font-weight: bold; color: #38bdf8; }
          .stat-label { font-size: 0.8rem; color: #94a3b8; text-transform: uppercase; margin-top: 5px; }
          .mode-option { background: #0f172a; border: 2px solid #334155; padding: 14px; border-radius: 8px; margin-bottom: 10px; cursor: pointer; transition: 0.2s; }
          .mode-option:hover { border-color: #38bdf8; }
          .mode-option.active { border-color: #10b981; background: #064e3b22; }
          .btn-save { background: #2563eb; color: #fff; border: none; padding: 10px 20px; border-radius: 8px; font-weight: bold; cursor: pointer; font-size: 0.95rem; width: 100%; transition: 0.2s; }
          .btn-save:hover { background: #1d4ed8; }
        </style>
        <script>
          let selectedMode = "${config.transmissionMode}";

          function selectMode(m) {
            selectedMode = m;
            document.querySelectorAll('.mode-option').forEach(el => el.classList.remove('active'));
            document.getElementById('opt-' + m).classList.add('active');
            document.getElementById('radio-' + m).checked = true;
          }

          async function guardarPolitica() {
            const clave = prompt('Ingresa la clave de administrador para aplicar este modo:');
            if (!clave) return;
            try {
              const res = await fetch('/api/set-mode', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mode: selectedMode, key: clave })
              });
              const json = await res.json();
              if (res.ok) {
                alert('¡Éxito! ' + json.message);
                location.reload();
              } else {
                alert('Error: ' + (json.error || 'No se pudo actualizar'));
              }
            } catch (e) {
              alert('Error de conexión: ' + e.message);
            }
          }

          async function eliminarCanal(canal) {
            const clave = prompt('Ingresa la clave de administrador para eliminar "' + canal + '":');
            if (!clave) return;
            try {
              const res = await fetch('/api/delete-channel', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ channel: canal, key: clave })
              });
              const json = await res.json();
              if (res.ok) {
                alert(json.message);
                location.reload();
              } else {
                alert('Error: ' + (json.error || 'No se pudo eliminar'));
              }
            } catch (e) {
              alert('Error de conexión: ' + e.message);
            }
          }
        </script>
      </head>
      <body>
        <div class="container">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 15px;">
            <div style="display:flex; align-items:center; gap:12px;">
              <span style="font-size:2.2rem;">📻</span>
              <div>
                <h1 style="margin:0; font-size: 1.5rem; color:#f8fafc;">Volkee Central Server</h1>
                <p style="margin:0; color:#94a3b8; font-size: 0.85rem;">Servidor PTT de Ultra-Baja Latencia | CIRE UNAH</p>
              </div>
            </div>
            <span class="badge">ONLINE 🟢</span>
          </div>

          <div class="stat-grid">
            <div class="stat-box">
              <div class="stat-num">${totalUsers}</div>
              <div class="stat-label">Radios Conectados</div>
            </div>
            <div class="stat-box">
              <div class="stat-num">${channels.size}</div>
              <div class="stat-label">Canales Activos</div>
            </div>
          </div>

          <!-- Selector de Modo de Transmisión -->
          <div class="card" style="border-top:4px solid #38bdf8;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
              <h3 style="margin:0; font-size:1.15rem; color:#38bdf8;">⚙️ Modo de Transmisión Activo</h3>
              <span style="font-size:0.8rem; background:#334155; padding:3px 8px; border-radius:6px; color:#cbd5e1;">Admin: admin123</span>
            </div>
            <p style="color:#94a3b8; font-size:0.85rem; margin-top:0; margin-bottom:14px;">
              Selecciona cómo se comportará el botón PTT en todos los radios conectados:
            </p>

            <div id="opt-blocked" class="mode-option ${config.transmissionMode === 'blocked' ? 'active' : ''}" onclick="selectMode('blocked')">
              <label style="cursor:pointer; display:flex; gap:10px; align-items:flex-start;">
                <input type="radio" id="radio-blocked" name="mode" value="blocked" ${config.transmissionMode === 'blocked' ? 'checked' : ''} style="margin-top:3px;">
                <div>
                  <strong style="color:#f8fafc; font-size:0.95rem;">🔒 Opción 1: Radio Profesional PTT (Bloqueo de Canal Ocupado) — RECOMENDADO</strong>
                  <div style="color:#94a3b8; font-size:0.8rem; margin-top:3px;">
                    El primero que presiona toma la frecuencia. Si otra persona intenta hablar a la vez, el servidor no la deja y la app emite tono de canal ocupado para no pisarse.
                  </div>
                </div>
              </label>
            </div>

            <div id="opt-free" class="mode-option ${config.transmissionMode === 'free' ? 'active' : ''}" onclick="selectMode('free')">
              <label style="cursor:pointer; display:flex; gap:10px; align-items:flex-start;">
                <input type="radio" id="radio-free" name="mode" value="free" ${config.transmissionMode === 'free' ? 'checked' : ''} style="margin-top:3px;">
                <div>
                  <strong style="color:#f8fafc; font-size:0.95rem;">🔓 Opción 2: Modo Libre (Sin Restricciones)</strong>
                  <div style="color:#94a3b8; font-size:0.8rem; margin-top:3px;">
                    Cualquiera puede transmitir libremente guiándose por el aviso en la pantalla LCD.
                  </div>
                </div>
              </label>
            </div>

            <div id="opt-conference" class="mode-option ${config.transmissionMode === 'conference' ? 'active' : ''}" onclick="selectMode('conference')">
              <label style="cursor:pointer; display:flex; gap:10px; align-items:flex-start;">
                <input type="radio" id="radio-conference" name="mode" value="conference" ${config.transmissionMode === 'conference' ? 'checked' : ''} style="margin-top:3px;">
                <div>
                  <strong style="color:#f8fafc; font-size:0.95rem;">👥 Opción 3: Modo Conferencia (Múltiples Oradores)</strong>
                  <div style="color:#94a3b8; font-size:0.8rem; margin-top:3px;">
                    Permite que varias personas transmitan simultáneamente al estilo de una llamada grupal.
                  </div>
                </div>
              </label>
            </div>

            <button class="btn-save" onclick="guardarPolitica()">💾 Guardar y Aplicar Modo en Vivo</button>
          </div>

          <h3 style="margin-top:20px; margin-bottom:10px; color:#cbd5e1;">Canales en Vivo</h3>
          ${channelListHtml}

          <div style="margin-top:25px; text-align:center; color:#64748b; font-size:0.8rem;">
            Modo actual: <b>${modeLabels[config.transmissionMode] || config.transmissionMode}</b> • TCP_NODELAY activo
          </div>
        </div>
      </body>
      </html>
    `);
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

// Servidor WebSocket
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  // Desactivar Nagle para enviar cada paquete de audio sin delay
  if (req && req.socket) {
    req.socket.setNoDelay(true);
  }

  ws.isAlive = true;
  ws.currentChannel = null;
  ws.uid = null;

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (data, isBinary) => {
    // Si es audio binario (PCM 16-bit 16kHz)
    if (isBinary) {
      if (!ws.currentChannel) return;

      // REGLA DE POLÍTICA:
      // Si el modo es 'blocked' (Radio Profesional): solo transmite el orador oficial del canal
      if (config.transmissionMode === 'blocked') {
        const activeSpeaker = channelSpeakers.get(ws.currentChannel);
        if (activeSpeaker && activeSpeaker !== ws.uid) {
          // Descartar audio del segundo orador para que nadie se pise
          return;
        }
      }

      // Transmitir a todos los demás en el canal
      broadcastAudio(ws.currentChannel, data, ws);
      return;
    }

    // Mensajes de señalización JSON
    try {
      const msg = JSON.parse(data.toString());
      switch (msg.type) {
        case 'join':
          joinChannel(ws, msg.channel || 'Canal 1 (General)', msg.uid);
          break;

        case 'leave':
          leaveCurrentChannel(ws);
          break;

        case 'talk_start':
          if (ws.currentChannel) {
            // VERIFICACIÓN DE POLÍTICA EN MODO BLOQUEO:
            if (config.transmissionMode === 'blocked') {
              const currentSpeaker = channelSpeakers.get(ws.currentChannel);
              if (currentSpeaker && currentSpeaker !== msg.uid) {
                // El canal ya está ocupado: notificar al usuario
                ws.send(JSON.stringify({
                  type: 'channel_busy',
                  speakerUid: currentSpeaker,
                  channel: ws.currentChannel
                }));
                return;
              }
            }

            // Canal asignado a este orador
            channelSpeakers.set(ws.currentChannel, msg.uid);
            broadcastJson(ws.currentChannel, {
              type: 'talk_start',
              channel: ws.currentChannel,
              uid: msg.uid
            }, ws);
          }
          break;

        case 'talk_stop':
          if (ws.currentChannel) {
            if (channelSpeakers.get(ws.currentChannel) === msg.uid) {
              channelSpeakers.delete(ws.currentChannel);
            }
            broadcastJson(ws.currentChannel, {
              type: 'talk_stop',
              channel: ws.currentChannel,
              uid: msg.uid
            }, ws);
          }
          break;

        case 'channel_created':
          broadcastAll({ type: 'channel_created' });
          break;
      }
    } catch (e) {
      console.error('Error procesando mensaje:', e);
    }
  });

  ws.on('close', () => {
    leaveCurrentChannel(ws);
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
    leaveCurrentChannel(ws);
  });
});

function joinChannel(ws, channelName, uid) {
  leaveCurrentChannel(ws);

  ws.currentChannel = channelName;
  ws.uid = uid;

  if (!channels.has(channelName)) {
    channels.set(channelName, new Set());
  }
  channels.get(channelName).add(ws);

  const speaker = channelSpeakers.get(channelName);
  ws.send(JSON.stringify({
    type: 'joined',
    channel: channelName,
    uid: uid,
    speakerUid: speaker || null,
    mode: config.transmissionMode
  }));
}

function leaveCurrentChannel(ws) {
  if (!ws.currentChannel) return;

  const ch = ws.currentChannel;
  const set = channels.get(ch);
  if (set) {
    set.delete(ws);
    if (set.size === 0 && ch !== 'Canal 1 (General)') {
      channels.delete(ch);
      channelSpeakers.delete(ch);
    }
  }

  if (channelSpeakers.get(ch) === ws.uid) {
    channelSpeakers.delete(ch);
    broadcastJson(ch, {
      type: 'talk_stop',
      channel: ch,
      uid: ws.uid
    }, ws);
  }

  ws.currentChannel = null;
}

function broadcastAudio(channelName, audioBuffer, senderWs) {
  const set = channels.get(channelName);
  if (!set) return;

  for (const client of set) {
    if (client !== senderWs && client.readyState === WebSocket.OPEN) {
      client.send(audioBuffer, { binary: true });
    }
  }
}

function broadcastJson(channelName, payload, senderWs) {
  const set = channels.get(channelName);
  if (!set) return;

  const str = JSON.stringify(payload);
  for (const client of set) {
    if (client !== senderWs && client.readyState === WebSocket.OPEN) {
      client.send(str);
    }
  }
}

function broadcastAll(payload) {
  const str = JSON.stringify(payload);
  for (const set of channels.values()) {
    for (const client of set) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(str);
      }
    }
  }
}

// Keep-alive cada 20 segundos
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      leaveCurrentChannel(ws);
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 20000);

wss.on('close', () => {
  clearInterval(heartbeatInterval);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`===================================================`);
  console.log(`📻 VOLKEE CENTRAL SERVER - MODO CONTROLADO`);
  console.log(`📡 Puerto local: http://localhost:${PORT}`);
  console.log(`🌐 Enlace Cloudflare: https://radio.cire-unah.site`);
  console.log(`⚙️ Modo de transmisión actual: ${config.transmissionMode}`);
  console.log(`🔑 Clave de Administración: ${ADMIN_KEY}`);
  console.log(`===================================================`);
});
