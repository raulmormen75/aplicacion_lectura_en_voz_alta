# Lector Documental Raul

PWA en Next.js para convertir PDF, Word, texto pegado y sitios web en lectura en voz alta con avance guardado, controles de reproducción y resaltado visual.

## Desarrollo local

```bash
npm install
npm run dev
```

Abre `http://localhost:3000`.

## Voces cloud

La app usa únicamente Azure Speech como voz cloud. Si Azure no está configurado, no responde o se alcanza el límite mensual configurado, la app cambia a la voz del navegador para evitar consumo de pago.

La pantalla muestra un contador pequeño de uso gratuito: porcentaje mensual usado en Azure y el periodo del mes calendario. El límite predeterminado es `500000` caracteres al mes.

## Contador global opcional

Por defecto, el contador vive en `localStorage` del navegador. Para que el consumo sea global entre dispositivos, configura un Redis compatible con Upstash o Vercel KV mediante REST. No se requiere dependencia adicional.

Variables opcionales aceptadas:

```env
VOICE_USAGE_REDIS_REST_URL=
VOICE_USAGE_REDIS_REST_TOKEN=
```

También se reconocen estas variables si el proveedor las crea automáticamente:

```env
KV_REST_API_URL=
KV_REST_API_TOKEN=
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=
```

## Variables de entorno

En Vercel agrega estas variables en `Production and Preview`.

```env
AZURE_SPEECH_KEY=
AZURE_SPEECH_REGION=
AZURE_TTS_MONTHLY_CHARACTER_LIMIT=500000
```

Notas:

- `AZURE_SPEECH_REGION` es la región del recurso, por ejemplo `eastus`, `westus2` o `mexicocentral` si tu cuenta la ofrece.
- La voz principal en español usa Azure `es-MX-DaliaNeural` para cuidar el nivel gratuito.
- Google Cloud Text-to-Speech no se usa en esta app porque requiere facturación y puede cobrar automáticamente al superar su tramo gratuito.

## Comandos de verificación

```bash
npm run lint
npm run build
```
