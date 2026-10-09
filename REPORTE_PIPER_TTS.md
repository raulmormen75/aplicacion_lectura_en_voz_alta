# REPORTE_PIPER_TTS

## Integración vigente de Laura: 9 de octubre de 2026

Alcance: integración para uso personal, local y no comercial. No se publica ni se despliega como parte de este cambio. Por instrucción posterior del usuario, el modelo se sirve desde el propio proyecto: `/models/laura/es_MX-laura-high.onnx` y su `.json`. La descarga de esos dos archivos fue realizada por el trabajo principal, no por este cambio del motor. Alojar el archivo en el proyecto no elimina la inicialización ni el costo de inferencia.

### Motor y garantías

- `synthesizePiperSpeech` conserva su API, su timeout predeterminado de 90 segundos y `createPiperEngine` sin modificaciones. Se mantienen cola FIFO, singleflight, cancelación y descarte del audio tardío. Cancelar libera la interfaz y rechaza la solicitud; no interrumpe el cálculo nativo ya iniciado. La cola espera su terminación antes de generar otro fragmento.
- Fonemización, descarga, validación e inferencia ONNX se ejecutan en un worker dedicado creado con `new Worker(new URL(..., import.meta.url))`. No se copian binarios de ONNX a `public/` ni se agregan dependencias. Un fallo fatal del worker invalida la sesión; el siguiente intento puede crear otra.
- Se reutiliza el flujo probado en `output/playwright/voice-lab/lab.mjs`, funciones `preparePhonemizer`, `pcmWav` y controlador de generación: Piper/eSpeak, tensores int64, escalas de configuración, WASM/CPU y WAV mono PCM16. La implementación también libera los tensores y rechaza audio vacío o no finito.
- `@realtimex/piper-tts-web` 1.1.1 no admite un modelo arbitrario en `TtsSessionOptions`: su implementación consulta `PATH_MAP[voiceId]` y un repositorio fijo. Localizador: `node_modules/@realtimex/piper-tts-web/dist/inference.d.ts`, interfaz completa `TtsSessionOptions`; `dist/piper-tts-web.js`, método `init`, líneas 284-307. **SOPORTE DIRECTO**, limitado a la versión instalada. No se utiliza un identificador de Claude para representar a Laura.
- La caché `reader-piper-laura-v1` almacena únicamente el modelo y su configuración mediante URL exacta. Se valida el modelo, incluso recuperado de caché, con SHA-256 `c1415da8e5409734e9be7623d34914461674eb1efc83873d5e6332cb61ed1068`. No se consulta OPFS ni la caché anterior de Claude. Los fallos de apertura, consulta o escritura no son fatales; los bytes corruptos se reemplazan solo después de validar una descarga completa.
- La persistencia depende del navegador, que puede desalojar la caché. El fonemizador y los recursos de ejecución siguen en CDN con versiones explícitas; esta integración no promete inicio completamente sin conexión. Los textos se envían únicamente al worker local, no a una API de síntesis. La caché persistente del motor no guarda texto ni audio.
- El respaldo Browser permanece en `ReaderApp.tsx`, fuera del alcance de estas ediciones. Los errores del motor se propagan al flujo existente, sin sustitución silenciosa de Laura por Claude. La interfaz, preferencias, estilos y paquetes son responsabilidad del trabajo principal.

### Evidencia y licencia

Fuentes consultadas el 9 de octubre de 2026. Se revisó el README original completo, incluido el contexto de todos los permisos, restricciones, propiedad intelectual, incumplimiento y contacto; también el texto íntegro del código legal CC BY-NC 4.0. Esta revisión documental no es un dictamen jurídico.

| Afirmación | Fuente y localizador | Contexto, clasificación y límites |
| --- | --- | --- |
| El repositorio identifica a HirCoir como publicador de Laura y declara `cc-by-nc-4.0`. | [README original](https://huggingface.co/HirCoir/Piper-TTS-Laura/blob/main/README.md), metadatos `license` y sección «Licencia de uso para el modelo de voz». | **SOPORTE DIRECTO** de lo declarado. No acredita por sí solo titularidad de todos los derechos, origen de los datos o consentimiento de la voz. |
| El texto propio hace opcional el crédito y prohíbe servicios de pago o usos comerciales que cobren a usuarios finales. | Mismo README, «Permisos», «Restricciones», «Propiedad intelectual», «Incumplimiento» y «Contacto». | **SOPORTE DIRECTO**. Se conserva crédito a HirCoir, enlace al modelo y aviso de licencia. No se interpreta la ausencia de cobro como autorización general de uso comercial. |
| CC BY-NC define NoComercial más ampliamente que la ausencia de cobro al usuario y exige atribución cuando se comparte material licenciado. | [Código legal completo CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/legalcode.es), secciones 1(i), 2(a)(1), 3(a), 5 y 6. | **SOPORTE DIRECTO**. Contempla ventaja comercial o compensación monetaria, atribución al compartir, ausencia de garantías y terminación por incumplimiento. No resuelve qué términos pretende aplicar el publicador ante las divergencias del README. |
| El ONNX original pesa aproximadamente 63.1 MB y tiene el hash usado por el motor. | [Archivo original](https://huggingface.co/HirCoir/Piper-TTS-Laura/blob/main/es_MX-laura-high.onnx), «Xet Pointer Details», campos de tamaño y SHA256. | **SOPORTE DIRECTO**. El archivo local de 63,122,309 bytes fue contrastado con ese hash. No es una medición de velocidad. |
| La configuración utiliza `es-419`, 22050 Hz y escalas 0.667, 1 y 0.8. | [Configuración original completa](https://huggingface.co/HirCoir/Piper-TTS-Laura/blob/main/es_MX-laura-high.onnx.json), objetos `audio`, `espeak`, `language` e `inference`. | **SOPORTE DIRECTO**. El nombre `es_MX` del archivo no demuestra edad, género, procedencia del hablante ni calidad percibida. |

**Delimitación:** las formulaciones del README y de CC BY-NC no son equivalentes. La autorización para publicación, redistribución o explotación comercial de esta integración queda **NO CONFIRMADA**; debe aclararse con HirCoir antes de ampliar el uso. Guardar el modelo en este repositorio local no autoriza subirlo a un repositorio público ni desplegarlo. Las licencias del código y del fonemizador deben revisarse por separado antes de distribuir; no se trasladan automáticamente desde el modelo.

### Comprobación de esta integración

- Pruebas enfocadas: `tests/laura.test.mjs`, `tests/laura-worker.test.mjs`, más las existentes `tests/piper-engine.test.mjs` y `tests/piper-timing.test.mjs`: 29 PASS.
- TypeScript sin emisión y lint enfocado del motor, helpers y pruebas: PASS con modelo local y worker. Verificación de diferencias sin errores de espacios: PASS.
- Prueba real reproducible: `tests/laura-browser.test.mjs`, activada con `LAURA_APP_URL=http://127.0.0.1:3016` y `LAURA_BROWSER_CHANNEL=msedge`. Usa Edge real y el motor de la aplicación, sin sustituir el modelo ni el runtime por simulaciones.
- Worker con origen remoto, comprobado antes del ajuste local: 136 palabras, audio de 37.99 y 37.71 segundos, PCM16 de 22050 Hz y señal no nula; recarga sin solicitar nuevamente el modelo y respaldo Browser a 390×844. Durante generación se observaron 663 y 705 eventos del temporizador de interfaz, con intervalos máximos de 29 y 60.6 ms. Son resultados de este equipo, no garantías para otros dispositivos.
- Ejecución final en Next con modelo servido desde `/models/laura/`: **PASS**. Primer fragmento de la aplicación: 9.706 segundos de audio en frío y 9.671 segundos tras recargar con la ruta del modelo bloqueada; 22050 Hz y señal no nula. La prueba comprobó las dos entradas locales de caché, un worker inicial y ausencia de solicitudes a Claude. No usa modelos o runtime simulados.
- Interfaz durante esa ejecución: 126 y 196 eventos de temporizador durante la generación; intervalos máximos de 46.6 y 52 ms. El botón Cancelar respondió en 48.4 ms, sin iniciar reproducción del resultado cancelado. La operación nativa continúa en el worker y conserva el bloqueo singleflight hasta terminar. Son observaciones de este equipo, no objetivos garantizados de latencia.
- Respaldo Browser: **PASS** al impedir acceso al modelo en un contexto limpio a 390×844. Se verificó la activación del respaldo, no la disponibilidad o calidad de voces del sistema. Resultado final: 29 pruebas enfocadas y 1 integración real aprobadas; esta última se omite por defecto si no se proporciona `LAURA_APP_URL`.
- Errores y recursos: pruebas de error nativo, fallo de inicialización, caída del worker, error de mensajes, cancelación y timeout aprobadas. Los tensores de entrada y salida se liberan tanto en éxito como en error; los workers fallidos se terminan. Se conserva una sesión nativa caliente y la caché de audio acotada del motor. No se realizó un perfil prolongado de memoria ni se garantiza consumo constante entre navegadores.
- Android/iOS físicos, valoración del timbre por el usuario, arranque totalmente offline y compilación de producción: **NO CONFIRMADOS** en esta intervención. No se modifica ni se regenera el precache del service worker; las pruebas de integración aíslan ese componente.

Archivos de esta intervención: `src/lib/reader/piper.ts`, `src/lib/reader/laura.ts`, `src/lib/reader/laura-worker-client.ts`, `src/lib/reader/laura-worker.ts`, `tests/laura.test.mjs`, `tests/laura-worker.test.mjs`, `tests/laura-browser.test.mjs` y este reporte. Los cambios concurrentes del trabajo principal no forman parte de esta lista.

### Validación posterior de la aplicación integrada

Comprobación del agente principal el 9 de octubre de 2026, en `http://127.0.0.1:3016/`:

- El primer documento de prueba repetía párrafos para alargarlo. Se sustituyó por un relato continuo de 617 palabras. No se aplicó una eliminación automática de párrafos repetidos a los documentos del usuario.
- Se recorrieron las cinco páginas, tanto a doble hoja en escritorio como a una hoja en móvil. Los 617 índices de palabra aparecen exactamente una vez y en orden. El texto completo reconstruido desde los bloques visibles coincide con la entrada, incluida su puntuación, al normalizar los espacios entre párrafos.
- Capturas reales: `output/playwright/en-voz-desktop.jpg` y `output/playwright/en-voz-mobile.jpg`. No se encontró desbordamiento horizontal. Se retiró la franja permanente de estado; los errores de importación siguen mostrándose cuando ocurren.
- Se comprobó el selector de voz y la velocidad 0.65 en pantalla completa. Laura inició con el modelo local y la ventana de preparación se cerró al empezar el audio. El primer fragmento de esta ejecución pasó de inicio a audio generado en aproximadamente 3.3 segundos, con recursos ya disponibles. No es una medición en frío ni una garantía para móviles físicos.
- Los fragmentos iniciales de Laura se limitan a 40 palabras y se prepara el siguiente mientras se reproduce el actual. El motor del navegador sigue disponible. El resaltado de Piper continúa siendo estimado, no alineación exacta por palabra.
- Lint aprobado; 183 pruebas aprobadas, ninguna fallida y una integración opcional omitida por defecto. La compilación de producción, pendiente en la revisión del motor anterior, quedó aprobada. El primer intento no pudo descargar las fuentes por la restricción de red del entorno; se repitió con acceso autorizado y terminó correctamente.
- Los cambios permanecen locales. No se ha realizado commit, push ni despliegue en esta intervención. Android/iOS físicos y el inicio totalmente sin conexión siguen pendientes.

## Historial anterior a Laura

Los apartados siguientes documentan la integración previa de Claude y sus revisiones. No describen la configuración vigente ni trasladan su licencia a Laura.

## 1. Diagnostico del proyecto

- Tipo de proyecto: PWA con Next.js 16 App Router, React 19 y TypeScript.
- Construccion: `npm.cmd run build`.
- Lint: `npm.cmd run lint`.
- Despliegue esperado: Vercel desde GitHub, con salida estandar de Next.js.
- Superficie principal: `src/components/reader/ReaderApp.tsx`.
- Assets estaticos: `public/`.
- Modelo de voz: no se sube el `.onnx` al repositorio. `@realtimex/piper-tts-web` descarga el modelo por `voiceId` y lo conserva en cache/OPFS del navegador.
- Service worker: `public/sw.js`. No se cambia para Piper porque el modelo y los WASM se descargan desde Hugging Face/CDN.
- Configuracion de bundler: `next.config.ts` usa `turbopack.resolveAlias` para ramas internas de Node (`fs`, `path`, `crypto`) que no deben ejecutarse en navegador.

## 2. Viabilidad tecnica

Resultado: viable con ajustes, como opcion seleccionable con respaldo obligatorio.

La app integra `@realtimex/piper-tts-web` y `onnxruntime-web` solo en cliente. En la barra de reproduccion hay dos modelos:

- `Voz estandar`: usa la voz disponible en el navegador con `speechSynthesis`.
- `Voz actualizada`: intenta iniciar Piper con `es_MX-claude-high`.

Si Piper falla, tarda demasiado o el navegador no puede reproducir el audio generado, la app vuelve automaticamente a `Voz estandar`.

Riesgos tecnicos:

- Primera carga pesada por descarga del modelo y archivos WASM.
- Piper no ofrece eventos palabra por palabra; el subrayado con `Voz actualizada` usa estimacion de avance.
- Android e iOS pueden variar mucho por memoria, CPU, politicas de audio y cache del navegador.
- La libreria permite configurar rutas locales para WASM, pero no una ruta local directa para el modelo `.onnx`; por eso no se aloja el modelo pesado en GitHub en esta version.
- Si Piper no termina de arrancar en 90 segundos, se usa `Voz estandar`.

## 3. Peso y rendimiento

- Modelo usado: `es_MX-claude-high`.
- Tamano aproximado del modelo: 60 a 63 MB.
- Metadata `.onnx.json`: alrededor de 5 KB.
- Archivos adicionales: ONNX Runtime WASM y `piper_phonemize`.
- Primera carga: puede tardar varios segundos o minutos, segun red y dispositivo.
- Refresco de pagina: el navegador puede reutilizar cache HTTP/OPFS, pero la sesion de inferencia se vuelve a inicializar.
- Borrado de datos del sitio: elimina cache/OPFS y obliga a descargar de nuevo.

## 4. Compatibilidad

- Edge escritorio: viable.
- Chrome escritorio: viable.
- Android Chromium/Edge: viable, pero requiere prueba en dispositivo real.
- iPhone/iPad: posible con WASM/CPU, con mayor riesgo de lentitud o memoria.
- Navegadores no compatibles: cualquier navegador sin soporte suficiente de WASM, OPFS o reproduccion de audio desde `Blob`.
- Fallback obligatorio: `speechSynthesis`.

## 5. Privacidad

- El texto se procesa localmente cuando Piper logra iniciar.
- La app no envia el texto a una API externa de TTS.
- El modelo se descarga desde Hugging Face y los archivos de ejecucion desde CDN; esos proveedores pueden ver solicitudes tecnicas normales de descarga.
- `speechSynthesis` depende del navegador: algunas voces pueden ser locales y otras remotas.

## 6. Licencias

- `@realtimex/piper-tts-web`: MIT segun el paquete publicado.
- `onnxruntime-web`: MIT.
- Voces Piper: el repositorio de voces indica MIT; la informacion del modelo `es_MX-claude-high` incluye datos con licencia Apache 2.0.
- Riesgo legal: componentes de fonemizacion basados en Piper/eSpeak pueden implicar obligaciones GPL segun distribucion real. Para uso personal/experimental el riesgo es manejable; para uso comercial conviene revision legal.

## 7. Recomendacion final

Mantener Piper como `Voz actualizada` seleccionable, con `Voz estandar` como respaldo automatico.

No conviene subir el modelo `.onnx` al repositorio por ahora: pesa alrededor de 60 MB, aumenta el repositorio y Vercel, y la libreria no ofrece una opcion limpia para cargar ese archivo desde `public/`. La ruta mas estable es descargarlo por `voiceId` y dejar que el navegador lo cachee.

## 8. Implementacion realizada

Archivos creados o modificados:

- `src/lib/reader/piper.ts`: carga dinamica de Piper, sesion cacheada, progreso y generacion de audio.
- `src/components/reader/ReaderApp.tsx`: selector `Voz estandar` / `Voz actualizada`, ventana de arranque, reproduccion Piper y fallback a voz estandar.
- `src/app/globals.css`: estilos del selector de voz, ventana de arranque y barra de reproduccion responsiva.
- `src/lib/empty-module.ts` y `next.config.ts`: alias de Turbopack para compilar dependencias de navegador.
- `package.json` y `package-lock.json`: dependencias `@realtimex/piper-tts-web` y `onnxruntime-web`.

Configuracion:

- No se requieren variables de entorno.
- No se usa API de pago.
- No se sube el modelo pesado al repositorio.

Pruebas realizadas:

- `npm.cmd run lint`.
- `npm.cmd run build`.
- Prueba local con texto pegado.
- Prueba de selector de modelo.
- Captura de escritorio.
- Captura movil.
- Verificacion de que no existe desbordamiento horizontal en la barra movil.

## Criterios de aceptacion

- La app compila sin errores.
- Si Piper falla, la app usa `Voz estandar`.
- No se sube el modelo pesado al repositorio.
- La UI muestra estados claros durante el arranque.
- La consola registra estados y tiempos de Piper.

## Revision de voces ligeras: 16 de septiembre de 2026

Se conserva la voz aprobada y el respaldo del navegador. No se encontro una sustitucion comprobada que cumpla simultaneamente voz femenina latinoamericana, timbre joven, menor descarga y funcionamiento con la biblioteca actual. Esto describe las candidatas revisadas, no la inexistencia de otras voces.

| Candidata | Evidencia revisada | Dictamen |
| --- | --- | --- |
| `es_MX-claude-high`, actual | Catalogo original: 63,122,309 bytes de ONNX. Ficha completa: Mexico, un hablante, calidad alta; no declara genero ni edad. | Conservar el sonido aprobado. No presentarlo como femenino joven por una inferencia del nombre. |
| `es_MX-ald-x_low` | Catalogo: 20,986,952 bytes. Ficha completa: datos sinteticos derivados de Ald medium; objetivo declarado de menor tamano y tiempo. | Menor descarga comprobada; calidad, genero y rendimiento real NO CONFIRMADOS. No cambiar la voz solo por peso. |
| `es_AR-daniela-high` | Catalogo: 114,199,011 bytes; Argentina. | No resuelve el peso inicial: supera al modelo actual. |
| Variantes FP16 | ONNX Runtime documenta reduccion de tamano y posibles beneficios en algunas GPU, con reservas de precision y operaciones CPU. | No asumir compatibilidad ni aceleracion en WASM. Requiere prueba separada de grafo, audio y dispositivos. |

Fuentes primarias: [catalogo Piper, objetos completos de cada voz](https://huggingface.co/rhasspy/piper-voices/resolve/main/voices.json), [ficha Claude, Dataset y Training](https://huggingface.co/rhasspy/piper-voices/blob/main/es/es_MX/claude/high/MODEL_CARD), [ficha Ald x-low, Dataset y Training](https://huggingface.co/rhasspy/piper-voices/blob/main/es/es_MX/ald/x_low/MODEL_CARD), [ONNX Runtime, Float16 y Mixed Precision](https://onnxruntime.ai/docs/performance/model-optimizations/float16.html).

Clasificacion: tamanos e idioma tienen soporte directo en el catalogo; la recomendacion de conservar Claude es una conclusion tecnica. La velocidad de descarga depende de la red, y la de generacion depende del dispositivo. Ninguna cifra de tamano constituye un benchmark. No se descargaron estas candidatas ni se enviaron documentos a demos externas durante esta comparacion.

La cache temporal de fragmentos implementada evita regenerar audio repetido dentro de la sesion, pero no reduce la primera descarga del modelo. El navegador puede desalojar sus caches. El resaltado Piper usa tiempos estimados ajustados al reloj del audio: no dispone de alineacion exacta por palabra y no debe describirse como tal.
