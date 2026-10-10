# En voz

Aplicación personal para leer PDF, DOCX, TXT/Markdown, texto pegado y sitios públicos en voz alta. Usa Next.js 16.4 y React 19.3, con lectura por páginas, avance local y controles por línea y párrafo.

## Voces y reproducción

El botón inferior de voces muestra únicamente las voces en español que expone el navegador. Incluye todas las variantes regionales y ambos géneros, sin duplicar entradas idénticas; ordena primero México, luego otras regiones latinoamericanas y finalmente España o español sin región. No descarga ni guarda modelos de voz.

La selección inicial prefiere una voz femenina mexicana cuando está disponible. Elegir otra voz conserva el punto del documento y la preferencia queda guardada en ese navegador. La detección se actualiza al abrir la aplicación o el menú, con el evento `voiceschanged`, al volver a la pestaña y con **Actualizar voces**. El menú también hace consultas breves para catálogos que aparecen tarde.

La aplicación no puede instalar voces ni obligar al navegador a exponer voces ausentes. Si no encuentra ninguna en español, lo indica al solicitar reproducción y no utiliza una voz inglesa por defecto. La calidad, la disponibilidad y el uso de conexión a Internet de cada voz dependen del sistema y navegador. La [especificación Web Speech API, §§4.2.2 y 4.2.8](https://webaudio.github.io/web-speech-api/) describe esta diferencia entre voces locales y servicios remotos del navegador.

Hugging Face y su API de audio se retiraron. La aplicación no tiene cuotas de generación de Hugging Face ni requiere claves para reproducir con voces del dispositivo. El código histórico de Laura/Piper y su atribución permanecen para trazabilidad; no se publican modelos ni se usan automáticamente. La caché antigua de Laura se elimina al abrir la aplicación.

Los controles inferiores incluyen velocidad y tamaño del texto; también están disponibles en pantalla completa. Los saltos entre líneas y párrafos no muestran diálogos de preparación. Los botones de segundos y el tiempo restante son estimaciones por palabras. El resaltado utiliza eventos de palabra cuando el motor los proporciona, con estimación temporal como respaldo.

## Importación y privacidad

PDF, DOCX, TXT y MD se procesan localmente, hasta 25 MiB por archivo y 300.000 caracteres de texto. Word antiguo `.doc` requiere convertirse a DOCX. PDF tiene límite de 200 páginas, 20.000 elementos de texto por página/100.000 totales y 20 páginas OCR. El lector identifica columnas conservadoramente y pide revisar esos resultados; ciertos diseños complejos, geometría inválida o texto girado se rechazan con un mensaje.

Al importar un PDF, un aviso central **Preparando tu PDF** desenfoca y bloquea el fondo, explica la reorganización del texto y aclara las posibles diferencias con el original. Muestra el avance por página y permite **Cancelar importación**, también con Escape. El documento y el avance anteriores se conservan ante cancelación o error; el aviso se cierra al terminar y devuelve el foco a los controles. DOCX y TXT conservan su flujo habitual.

El análisis de PDF aprovecha las etiquetas semánticas de títulos, subtítulos, párrafos y listas cuando cubren el texto de forma consistente. En los demás casos combina posición, tamaño, separación y sangría para reconstruir líneas y párrafos, unir palabras cortadas y ordenar dos columnas cuando hay evidencia suficiente. Solo omite contenido marcado explícitamente como decoración (`Artifact`). Conserva la clasificación de bloques en el documento guardado, sin reclasificar frases cortas como títulos. Las listas numeradas mantienen sus números. Es una reconstrucción del texto, no una reproducción exacta del diseño de página ni un modelo generativo.

DOCX valida el ZIP y su expansión real antes de Mammoth. En cliente se permiten hasta 512 entradas, 32 MiB expandidos en total, 8 MiB por entrada y 4 MiB por XML/relaciones. Requiere `DecompressionStream("deflate-raw")`; si no existe, se indica actualizar el navegador o exportar TXT. No se abren archivos externos ni se incrustan imágenes.

OCR con Tesseract requiere descargar su motor e idiomas. Esto es independiente de las voces. Revisa nombres, cifras, tablas y fórmulas del resultado. La limpieza no une variables separadas y conserva/verbaliza operaciones; bloques, fragmentos e índices se crean a partir de una sola preparación del texto.

Para páginas escaneadas, OCR conserva párrafos y cajas de línea y utiliza esa geometría en el mismo análisis. Si las cajas son incompletas o ambiguas, conserva el texto reconocido para revisión. El reconocimiento y la reorganización se ejecutan en el dispositivo; no se envía el PDF a una API. Un escaneo puede contener errores de reconocimiento que esta reorganización no corrige.

Documentos, avance, voz elegida y tamaño del texto se guardan automáticamente en el mismo navegador y se recuperan al volver. El documento se conserva en IndexedDB; el punto de reproducción y las preferencias, en un registro local compacto. No hay ventana de ajustes, selector de idioma ni interruptor de sesión temporal. Para eliminar lo conservado se pueden borrar los datos de este sitio desde el navegador. Los errores reales de almacenamiento se muestran para evitar aparentar que el avance se guardó.

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
npm run test:browser:pdf
```

Abre `http://localhost:3000`. Predev/prebuild preparan recursos PDF.js/Tesseract desde las dependencias; no hay que subirlos. La compilación genera el shell offline de la PWA. Offline puede recuperar la interfaz y documentos guardados después de una visita completa. La reproducción sin conexión depende de que la voz del dispositivo sea local; OCR necesita sus recursos descargados.

CSP limita recursos y conserva `unsafe-inline` para el shell estático de Next. Las respuestas con documentos usan `no-store`. La antigua API `/api/speech` ya no se publica.

La prueba de navegador inicia el servidor compilado y usa perfiles aislados y un catálogo de voces simulado. Comprueba los anchos 1280, 914, 390 y 320 px: detección tardía, filtro de español, actualización del catálogo, teclado, selección, transporte, tamaño del texto, alineación, persistencia y recuperación del documento, pantalla completa y ausencia de solicitudes de TTS remoto. También comprueba que una voz inglesa no sea el respaldo y una recarga offline con preparación local. Estas pruebas verifican el comportamiento de la aplicación; no evalúan calidad audible ni la presencia real de una voz en el equipo del usuario.

La suite `test:browser:pdf` comprueba el aviso central en escritorio y móvil, Cancelar/Escape, foco, fondo bloqueado, progreso por página, errores, persistencia y recarga. Usa PDF.js y su worker reales con PDFs sintéticos etiquetados, sin etiquetas, de dos columnas y de imagen. En la integración OCR controla únicamente la salida de Tesseract para verificar la transferencia de párrafos/cajas, cancelación durante reconocimiento y reintento; esa prueba no mide la precisión de OCR. Las pruebas unitarias cubren etiquetas incompletas o anómalas, orden semántico, límites y conservación del texto.

También se comprobó manualmente el flujo con Tesseract 7, su WASM y los idiomas originales español/inglés sobre un PDF de imagen sintético. Recuperó un título, un párrafo y dos viñetas, con errores de reconocimiento de algunas palabras del mapa de bits. Esa comprobación confirma la integración real; no garantiza fidelidad para cualquier escaneo.

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
