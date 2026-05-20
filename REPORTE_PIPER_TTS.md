# REPORTE_PIPER_TTS

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
