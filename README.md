# Lector Documental Raul

PWA en Next.js para convertir PDF, Word, texto pegado y sitios web en lectura en voz alta con avance guardado, controles de reproducción y resaltado visual.

## Desarrollo local

```bash
npm install
npm run dev
```

Abre `http://localhost:3000`.

## Voz de lectura

La app usa únicamente la voz disponible en el navegador mediante `speechSynthesis`. No llama a Azure, Google Cloud ni OpenAI para generar audio.

En Edge, cuando el navegador expone `Microsoft Dalia Online (Natural) - Spanish (Mexico)`, la app la prioriza para lecturas en español de México. Si esa voz no está disponible, usa la voz predeterminada compatible del navegador o del sistema.

## Variables de entorno

Para la lectura en voz alta del navegador no se necesita ninguna llave de pago.

```env
NEXTAUTH_URL=
NEXTAUTH_SECRET=
GPT_OSS_ENDPOINT=
```

Notas:

- La calidad de la voz depende de las voces que cada navegador y sistema operativo expongan a la Web Speech API.
- En escritorio, Edge suele ofrecer mejores voces naturales de Microsoft que otros navegadores.
- La reconstrucción con IA ligera es opcional y no corre dentro del navegador. Si `GPT_OSS_ENDPOINT` queda vacío, la app usa limpieza local sin inventar contenido.

## Comandos de verificación

```bash
npm run lint
npm run build
```
