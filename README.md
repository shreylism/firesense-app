# FIRESENSE web dashboard
npm install && npm run dev        # demo mode (simulated data)
cp .env.example .env              # set VITE_API_URL to use the real backend

Backend contract:
- GET  /api/v1/status            -> live payload (see src/useLive.js)
- WS   /ws/live                  -> same payload, pushed on each packet
- GET  /api/v1/history?device=&range=1h|24h|7d
- GET  /api/v1/export.csv?device=&range=
- POST /api/v1/auth/login        -> {access_token}
- GET/PUT /api/v1/config         -> thresholds (admin)
