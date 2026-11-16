# CIRE UNAH - Radio Push-To-Talk (PTT)

Aplicación Android de Radio Walkie-Talkie profesional conectada al servidor privado de voz de CIRE UNAH sobre WebSockets y Cloudflare Tunnel.

## Características
- 🎙️ **Minutos Ilimitados:** Conexión directa a `wss://radio.cire-unah.site`.
- 🔒 **Canales Públicos y Privados:** Con PIN de 4 dígitos sincronizados con Supabase (`cire_channels`).
- 🔊 **Audio de Alta Fidelidad en Altavoz:** PCM 16kHz 16-bit Mono con cancelación acústica de eco y supresión de ruido.
- 📱 **PTT Físico con Pantalla Bloqueada:** Presiona el botón de **Bajar Volumen** con la pantalla apagada o en el bolsillo para hablar en vivo.
- ⚡ **Servicio en Segundo Plano Persistente:** Notificación activa para escuchar transmisiones sin que Android cierre la app.
- 📻 **Interfaz Táctica Retro:** Display LCD estilo radio militar con LEDs indicadores TX (rojo) y RX (verde).
