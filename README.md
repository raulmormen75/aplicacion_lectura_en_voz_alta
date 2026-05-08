# Lector Documental Raul

PWA en Next.js para convertir PDF, Word, texto pegado y sitios web en lectura en voz alta con avance guardado, controles de reproducción y resaltado visual.

## Desarrollo local

```bash
npm install
npm run dev
```

Abre `http://localhost:3000`.

## Voces cloud

La app intenta sintetizar cada fragmento en este orden:

1. Azure Speech.
2. Google Cloud Text-to-Speech, cuando Azure no está configurado, falla o supera el presupuesto mensual configurado.
3. Voz del navegador, solo como respaldo final.

El cambio entre Azure y Google se calcula por caracteres sintetizados en el mes calendario. La pantalla muestra un contador pequeño de uso gratuito: porcentaje usado en Azure, porcentaje usado en Google y la fecha en que reinicia el periodo mensual.

En esta versión personal, el contador vive en `localStorage` del navegador; si se necesita un conteo global entre dispositivos, hay que agregar una base de datos o KV en servidor.

## Variables de entorno

En Vercel agrega estas variables en `Production and Preview`.

```env
AZURE_SPEECH_KEY=
AZURE_SPEECH_REGION=
GOOGLE_TTS_SERVICE_ACCOUNT_JSON=
AZURE_TTS_MONTHLY_CHARACTER_LIMIT=500000
GOOGLE_TTS_MONTHLY_CHARACTER_LIMIT=1000000
```

Notas:

- `AZURE_SPEECH_REGION` es la región del recurso, por ejemplo `eastus`, `westus2` o `mexicocentral` si tu cuenta la ofrece.
- `GOOGLE_TTS_SERVICE_ACCOUNT_JSON` puede ser el JSON completo de la cuenta de servicio o el mismo JSON convertido a base64.
- Los límites mensuales son configurables para no depender de valores fijos dentro del código.
- La voz principal en español usa Azure `es-MX-DaliaNeural` para cuidar el nivel gratuito. Google se usa como respaldo con una voz natural `es-US`, porque Google Cloud no siempre ofrece una voz `es-MX` natural equivalente en todos los proyectos.

## Comandos de verificación

```bash
npm run lint
npm run build
```
