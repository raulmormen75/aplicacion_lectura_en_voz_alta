# En voz

Aplicación personal para leer PDF, DOCX, TXT/Markdown, texto pegado y sitios públicos en voz alta. Usa Next.js 16.4 y React 19.3, con lectura por páginas, avance local y controles por línea y párrafo.

## Voces y reproducción

- **Dispositivo** es la opción inicial. No descarga modelos. Prioriza las voces de español de México disponibles y permite elegir una voz concreta en Ajustes. La calidad y disponibilidad dependen del navegador y sistema; una voz del sistema puede usar el servicio remoto de su proveedor.
- **México · HF** usa la demo oficial Chatterbox es-MX/LatAm y su referencia `es_mx_f1.wav`, obtenida de la configuración actual de la demo. Es una opción experimental con cola y cuota de Hugging Face ZeroGPU.
- **Dora · HF** usa Kokoro `ef_dora` mediante la demo española comunitaria de leonelhs. Dora está documentada como femenina española; el catálogo no confirma acento mexicano.

Al elegir una demo, se envían fragmentos de texto a Hugging Face. La aplicación recibe WAV, mantiene un búfer temporal de hasta 16 MiB/32 entradas y no guarda modelos ni audio en IndexedDB, CacheStorage o el servidor. El proveedor puede conservar los archivos generados según sus políticas: no se garantiza eliminación por parte del proveedor. No uses una demo pública para documentos confidenciales.

Las voces remotas no son streaming: una sección nueva requiere generación completa y puede esperar por la cola. En pruebas con una frase pública, ambas APIs entregaron audio, con unos 9 segundos hasta generación y 12 segundos hasta descarga desde el entorno de prueba. No es un benchmark de tu dispositivo ni de documentos largos, ni una evaluación audible de calidad.

Los fragmentos tienen límites estables, se reutilizan al saltar dentro de ellos y se anticipan las siguientes secciones. El reproductor cambia de posición dentro del audio preparado; las respuestas de sesiones canceladas no inician otra lectura. Los saltos no muestran diálogos de carga. Si una demo falla, se informa de forma visible y el selector cambia a Dispositivo; pausa y reanudación siguen al proveedor activo.

La integración anterior de Laura se retiró de la selección de lectura. Su caché de modelo se elimina al abrir esta versión. El modelo de 63 MB ya no se publica; el código histórico y la atribución permanecen para trazabilidad, sin descarga ni uso automático. No se utiliza Azure ni una API de pago.

El resaltado de audio remoto es aproximado, basado en duración y actividad del audio. Los botones de segundos usan el reloj real dentro del fragmento remoto activo; fuera de ese fragmento y con voces del dispositivo se estima el destino por palabras. El tiempo restante siempre es una estimación.

## Importación y privacidad

PDF, DOCX, TXT y MD se procesan localmente, hasta 25 MiB por archivo y 300.000 caracteres de texto. Word antiguo `.doc` requiere convertirse a DOCX. PDF tiene límite de 200 páginas, 20.000 elementos de texto por página/100.000 totales y 20 páginas OCR. El lector identifica columnas conservadoramente y pide revisar esos resultados; ciertos diseños complejos, geometría inválida o texto girado se rechazan con un mensaje.

DOCX valida el ZIP y su expansión real antes de Mammoth. En cliente se permiten hasta 512 entradas, 32 MiB expandidos en total, 8 MiB por entrada y 4 MiB por XML/relaciones. Requiere `DecompressionStream("deflate-raw")`; si no existe, se indica actualizar el navegador o exportar TXT. No se abren archivos externos ni se incrustan imágenes.

OCR con Tesseract requiere descargar su motor e idiomas. Esto es independiente de las voces. Revisa nombres, cifras, tablas y fórmulas del resultado. La limpieza no une variables separadas y conserva/verbaliza operaciones; bloques, fragmentos e índices se crean a partir de una sola preparación del texto.

Por defecto, documentos y avance se conservan localmente. **Lectura temporal**, en Ajustes, detiene el autoguardado durante esta sesión; los datos anteriores se conservan. **Borrar datos del lector** elimina las versiones documentales y el estado anterior, detiene reproducción y activa lectura temporal. Solo queda una revisión sin datos personales para impedir que una pestaña antigua restaure el contenido. El botón puede completar un borrado interrumpido; la carga nunca lo hace automáticamente.

Los sitios públicos se descargan en el servidor con límites, validación DNS/pinning y protección contra destinos privados. La reconstrucción con IA es opcional, solo aparece cuando se configura y envía texto únicamente al solicitarla. No se sincroniza entre dispositivos.

## Desarrollo y verificación

Node.js 24 recomendado; mínimo 22.13.

```bash
npm ci
npm run dev
npm test
npm run lint
npm run build
npx playwright install chromium
npm run test:browser
```

Abre `http://localhost:3000`. Predev/prebuild preparan recursos PDF.js/Tesseract desde las dependencias; no hay que subirlos. La compilación genera el shell offline de la PWA. Offline puede recuperar la interfaz y documentos guardados después de una visita completa, pero no permite generar voces remotas ni garantiza OCR sin recursos descargados.

La API `/api/speech` acepta solo las dos voces y fragmentos breves. Valida origen, tipo, bytes, URLs de audio del mismo Space y WAV. Sus cuotas/concurrencia se guardan en memoria acotada por proceso y no son un control distribuido ni autenticación. CSP limita recursos y conserva `unsafe-inline` para el shell estático de Next. Las respuestas con documento o audio usan `no-store`.

La prueba de navegador inicia el servidor compilado y usa perfiles aislados, texto público de prueba y un WAV generado para comprobar transporte, saltos de línea/párrafo, respaldo, pantalla completa y privacidad en escritorio y móvil. También comprueba la protección de origen en la API real y una recarga offline con preparación de texto local. `READER_VERIFY_HF_LIVE=1 npm run test:browser` añade dos generaciones reales en las demos públicas, sujetas a su disponibilidad y cuota.

GitHub Actions verifica instalación, tests, lint, build y navegador en Node 24. Vercel compila automáticamente los cambios en `main`; un build local no prueba que ya estén publicados.

## Configuración opcional

No se necesitan tokens ni cuentas de pago para las demos públicas actuales. Su disponibilidad puede cambiar.

```env
NEXTAUTH_URL=
NEXTAUTH_SECRET=
GPT_OSS_ENDPOINT=
```

La ruta de autenticación histórica no es necesaria para leer documentos. `GPT_OSS_ENDPOINT` se configura únicamente para reconstrucción opcional. `vercel.json` conserva la compatibilidad ESM del procesador HTML mediante `NODE_OPTIONS=--experimental-require-module`.

## Fuentes de las voces

Consultadas el 9 de octubre de 2026, hora de México:

- Resemble AI. *Chatterbox-Multilingual-es-mx-latam*. Consultado de: https://huggingface.co/ResembleAI/Chatterbox-Multilingual-es-mx-latam
- Resemble AI. *Demo mexicana, app.py*. Consultado de: https://huggingface.co/spaces/ResembleAI/Chatterbox-Multilingual-TTS-es-mx-latam/blob/main/app.py
- hexgrad. *Kokoro-82M, Voices*. Consultado de: https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md
- leonelhs. *Kokoro TTS Spanish, app.py*. Consultado de: https://huggingface.co/spaces/leonelhs/kokoro-tts-spanish/blob/main/app.py
- Hugging Face. *Spaces as API endpoints* y *Spaces ZeroGPU*. Consultado de: https://huggingface.co/docs/hub/en/spaces-api-endpoints y https://huggingface.co/docs/hub/en/spaces-zerogpu
