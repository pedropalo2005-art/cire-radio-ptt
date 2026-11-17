const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = 8888;
const ADMIN_KEY = "admin123"; // Clave para eliminar canales desde la web

// Canales en memoria y oradores
const channels = new Map(); // channelName -> Set of sockets
const channelSpeakers = new Map(); // channelName -> uid

const server = http.createServer((req, res) => {
  // Desactivar Nagle a nivel HTTP
  if (req.socket) req.socket.setNoDelay(true);

  // Endpoint para eliminar canales desde la web del admin
  if (req.method === 'POST' && req.url === '/api/delete-channel') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (data.key !== ADMIN_KEY) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Clave de admin incorrecta' }));
        }

        const channelToDelete = data.channel;
        if (!channelToDelete || channelToDelete === 'Canal 1 (General)') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'No se puede eliminar el canal principal' }));
        }

        // Mover a los usuarios en ese canal al general
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

        // Avisar a todos los radios que refresquen su lista
        broadcastAll({ type: 'channel_created' });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: `Canal ${channelToDelete} eliminado` }));
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
        <div style="background:#1e293b; padding:16px; border-radius:10px; margin-bottom:12px; border-left:5px solid ${speaker ? '#ef4444' : '#10b981'}; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
          <div>
            <div style="font-size:1.15rem; font-weight:bold; color:#f8fafc;">📻 ${name}</div>
            <div style="color:#94a3b8; font-size:0.85rem; margin-top:4px;">
              Usuarios activos: <span style="color:#38bdf8; font-weight:bold;">${set.size}</span>
              ${speaker ? `<span style="background:#dc2626; color:#fff; padding:2px 8px; border-radius:12px; margin-left:10px; font-size:0.75rem; font-weight:bold;">HABLANDO: UID ${speaker}</span>` : `<span style="background:#15803d; color:#fff; padding:2px 8px; border-radius:12px; margin-left:10px; font-size:0.75rem;">Libre</span>`}
            </div>
          </div>
          ${!isGeneral ? `
            <button onclick="eliminarCanal('${name}')" style="background:#b91c1c; hover:background:#dc2626; color:#fff; border:none; padding:8px 14px; border-radius:6px; cursor:pointer; font-weight:600; font-size:0.85rem; transition:0.2s;">
              🗑️ Eliminar Canal
            </button>
          ` : `<span style="color:#64748b; font-size:0.8rem; font-style:italic;">Canal Protegido</span>`}
        </div>
      `;
    }).join('') || '<div style="color:#94a3b8; text-align:center; padding:20px;">No hay canales con actividad en memoria todavía.</div>';

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
          .container { max-width: 720px; margin: 0 auto; }
          .card { background: #1e293b; border-radius: 12px; padding: 24px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.3); }
          .badge { display: inline-block; padding: 4px 10px; border-radius: 9999px; font-size: 0.85rem; font-weight: 600; background: #10b981; color: #fff; }
          .stat-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin: 20px 0; }
          .stat-box { background: #0f172a; padding: 15px; border-radius: 8px; text-align: center; }
          .stat-num { font-size: 2rem; font-weight: bold; color: #38bdf8; }
          .stat-label { font-size: 0.8rem; color: #94a3b8; text-transform: uppercase; margin-top: 5px; }
        </style>
        <script>
          async function eliminarCanal(canal) {
            const clave = prompt('Ingresa la clave de administrador para eliminar el canal "' + canal + '":');
            if (!clave) return;
            try {
              const res = await fetch('/api/delete-channel', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ channel: canal, key: clave })
              });
              const json = await res.json();
              if (res.ok) {
                alert(json.message || 'Canal eliminado exitosamente');
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
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 20px;">
            <div style="display:flex; align-items:center; gap:12px;">
              <span style="font-size:2.2rem;">📻</span>
              <div>
                <h1 style="margin:0; font-size: 1.6rem; color:#f8fafc;">Volkee Radio Server</h1>
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

          <h3 style="margin-top:25px; margin-bottom:12px; color:#cbd5e1;">Canales en Vivo</h3>
          ${channelListHtml}

          <div style="margin-top:30px; text-align:center; color:#64748b; font-size:0.8rem;">
            Actualización automática cada 3s • Latencia optimizada TCP_NODELAY
          </div>
        </div>
        <script>
          setTimeout(() => location.reload(), 3000);
        </script>
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
  // Desactivar algoritmo de Nagle para enviar paquetes de audio instantáneamente
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
    // Si es audio binario (PCM 16-bit)
    if (isBinary) {
      if (ws.currentChannel) {
        broadcastAudio(ws.currentChannel, data, ws);
      }
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
            channelSpeakers.delete(ws.currentChannel);
            broadcastJson(ws.currentChannel, {
              type: 'talk_stop',
              channel: ws.currentChannel,
              uid: msg.uid
            }, ws);
          }
          break;

        case 'channel_created':
          // Reenviar a todos para que actualicen su lista de canales
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
    speakerUid: speaker || null
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

// Keep-alive cada 20s
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
  console.log(`===============================================`);
  console.log(`📻 VOLKEE RADIO SERVER - ULTRA BAJA LATENCIA`);
  console.log(`📡 Puerto local: http://localhost:${PORT}`);
  console.log(`🌐 Enlace Cloudflare: https://radio.cire-unah.site`);
  console.log(`🔑 Clave Web Admin: ${ADMIN_KEY}`);
  console.log(`===============================================`);
});
