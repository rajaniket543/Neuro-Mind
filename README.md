# Deploying the NeuroMind

This project is now set up so one Node service can serve both:

- the built React frontend from `dist/`
- the backend API from `server.mjs`

## Before deploying

1. Build the frontend:

```bash
npm run build
```

2. Use environment variables from `.env.example`.

Important:

- leave `VITE_API_BASE_URL` empty when frontend and backend are on the same deployed service
- for cloud hosting, prefer `LLM_PROVIDER=gemini`
- if you keep `LLM_PROVIDER=ollama`, your host must also be able to reach an Ollama server

## Recommended hosting

Use a Node host that can run:

- Build command: `npm run build`
- Start command: `npm start`

Examples:

- Render web service
- Railway service
- VPS with Node installed

## Important persistence note

This app writes data into `data/db.json`.

That means:

- many hosts will lose changes on restart/redeploy unless you attach persistent storage
- if you want reliable production data, move this to a real database later

## Render example

- Root directory: project root
- Build command: `npm run build`
- Start command: `npm start`
- Add env vars from `.env.example`

If you want, the next step can be converting `data/db.json` storage to a real hosted database so patient/chat data does not reset.
