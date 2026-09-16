# Lector Documental Raul

PWA en Next.js para convertir PDF, Word, texto pegado y sitios web en lectura en voz alta con avance guardado, controles de reproducción y resaltado visual.

## Desarrollo local

```bash
npm install
npm run dev
```

Abre `http://localhost:3000`.

## Voz de lectura

La app conserva dos opciones: **Voz estándar**, mediante `speechSynthesis`, y **Voz actualizada**, mediante Piper en el dispositivo. No llama a Azure, Google Cloud ni OpenAI para generar audio.

En Edge, cuando el navegador expone `Microsoft Dalia Online (Natural) - Spanish (Mexico)`, la app la prioriza para lecturas en español de México. Si esa voz no está disponible, usa la voz predeterminada compatible del navegador o del sistema.

En Android, Edge puede no exponer Dalia a las páginas web aunque exista la función interna “Leer en voz alta”. La app espera brevemente a que el navegador publique sus voces y selecciona Dalia si aparece; si Android no la entrega mediante `speechSynthesis`, no se puede forzar desde una PWA. En ese caso, la app prefiere una voz de español latino antes que una de español de España cuando el navegador la ofrece.

Piper descarga `es_MX-claude-high` y sus recursos cuando se solicita por primera vez. El modelo pesa aproximadamente 63 MB, además del motor. La caché del navegador puede evitar descargas posteriores, pero el motor vuelve a inicializarse al abrir una nueva página. La disponibilidad de caché depende del espacio y de las políticas del navegador. Los fragmentos de audio recientes se reutilizan en memoria durante la sesión; no constituyen una biblioteca de audio persistente.

El texto se sintetiza localmente con Piper. La voz estándar depende del proveedor del navegador y puede ser un servicio en línea: no se garantiza procesamiento local para todas las voces del sistema. Si Piper no puede arrancar, se informa y se usa la voz estándar. El resaltado de Piper es una estimación basada en el reloj y la actividad del audio, no una alineación exacta por palabra.

## Documentos y privacidad

- PDF, DOCX y TXT se procesan en el navegador, con límite de 25 MB por archivo. El formato Word antiguo `.doc` no se admite; debe convertirse a DOCX.
- Los PDF escaneados usan OCR local con Tesseract. El motor y los idiomas requieren descarga inicial. El reconocimiento puede equivocarse en nombres, cifras, tablas y columnas; el resultado debe revisarse.
- El texto pegado se prepara sin enviarlo al servidor.
- Para importar un sitio público, el servidor descarga la URL solicitada con límites de tiempo, tamaño y destinos. Sitios privados o que requieren iniciar sesión no están admitidos.
- El contenido procesado se guarda en IndexedDB y el avance y las preferencias en el almacenamiento del navegador. No hay sincronización entre dispositivos. Borrar los datos del sitio elimina esta continuidad.
- No se almacena el archivo original. La reconstrucción opcional con IA envía el texto al servicio configurado solo cuando se solicita esa acción.

## Construcción y despliegue

`npm run dev` y `npm run build` preparan automáticamente los archivos de PDF.js y Tesseract en `public/reader-assets/`. Estos recursos se copian de las dependencias instaladas; no es necesario subirlos al repositorio. El modelo Piper tampoco se incluye en Git.

En Vercel se usa Next.js con la raíz del repositorio, instalación automática y `npm run build`. No se requiere una API de pago para las dos opciones de voz. La validación local no acredita por sí sola que una nueva versión esté publicada.

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
npm test
npm run build
```
