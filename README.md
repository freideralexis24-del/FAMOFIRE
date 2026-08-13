# FAMOFIRE — Juego multijugador online

Battle Royale 2D (35 jugadores = reales + bots) con emparejamiento global, habilidades, skins, rango militar y Ranking Global Top 100.

## Requisitos
- Node.js 18 o superior

## Probar en tu PC (local)
```
npm install
npm start
```
Abre `http://localhost:3000` y crea una segunda pestaña para jugar contra ti mismo.

## Jugar en tu red local (amigos en casa / mismo WiFi)
1. `npm start`
2. Averigua tu IP local: `ipconfig` (busca "IPv4", ej. `192.168.1.20`)
3. Tus amigos entran con `http://192.168.1.20:3000` desde su celular/PC (mismo WiFi)
4. Ojo: Windows debe permitir el puerto 3000 en el Firewall (puede pedir permiso al iniciar)

## Publicarlo en la web (gratis, para jugar desde cualquier lugar)

### Opción A — Render.com (recomendado, gratis)
1. Sube esta carpeta a un repositorio de GitHub
2. En https://render.com → "New" → "Web Service" → conecta tu repo
3. Configuración:
   - Build Command: `npm install`
   - Start Command: `node server.js`
4. Crea el servicio y te dará una URL tipo `https://tu-juego.onrender.com`
5. Comparte esa URL: cualquiera entra y juega

### Opción B — Railway.app
1. "New Project" → "Deploy from GitHub repo" → misma configuración (`npm install` / `node server.js`)
2. Te da una URL tipo `https://tu-juego.up.railway.app`

### Opción C — Fly.io
```
fly launch
fly deploy
```

> Importante: el cliente se conecta automáticamente al mismo servidor que le dio la página (ya no usa `localhost`), así que funciona en cualquier hosting sin cambios de configuración.

## Datos que guarda el servidor
- `ranking.json` — puntos de todos los jugadores para el Top 100 (se crea automáticamente)

## Partida en línea (35 cupos)
- Al entrar a CAMPO DE BATALLA → BUSCAR PARTIDA te unes a la cola global
- La partida inicia cuando se llenan 35 jugadores reales o a los 30 segundos
- Los cupos vacíos se rellenan con bots
- Jugadores reales se ven, se disparan y se eliminan; la última persona en pie gana
- Las bajas y puntos de rango se actualizan en el Ranking Global

## Pruebas automáticas
```
npm test
```
Simula 2 jugadores reales: emparejamiento, sincronización de posiciones, daño, baja, victoria y ranking.
