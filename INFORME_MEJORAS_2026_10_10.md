# En voz: mejoras y verificación

Este informe describe la etapa anterior. Las voces de Hugging Face y la ventana de ajustes se retiraron siguiendo las indicaciones posteriores del usuario; README y GOAL.md describen el funcionamiento actual con voces del dispositivo en español y guardado automático.

Fecha: 10 de octubre de 2026 (UTC; investigación iniciada el 9 de octubre, hora de México).

## Objetivo y resultado de código

Se corrige la interrupción de la lectura causada por ventanas de preparación de voz en cada salto. La lectura comienza con las voces disponibles del dispositivo, sin descargar modelos. Las alternativas de Hugging Face se ofrecen de forma explícita y experimental; no se utiliza Azure ni una API de pago. El objetivo y sus condiciones de cierre están en `GOAL.md`; este archivo no activa un modo nativo `/goal` del cliente.

La aplicación sigue siendo personal, con procesamiento local de archivos, progreso local, páginas de libro, OCR y lectura de sitios públicos. Se conserva el diseño negro, marfil y dorado. Las correcciones se organizan por responsabilidad en los siguientes archivos:

| Área | Implementación | Cambio principal |
| --- | --- | --- |
| Reproducción y controles | `src/components/reader/ReaderApp.tsx` | Saltos sin diálogo, reutilización de audio, pausa, respaldo y ajustes |
| Búfer de voz | `src/lib/reader/speech-buffer.ts` | Ventanas estables, anticipación, LRU acotada, cancelación y prioridad |
| Voz remota | `src/lib/server/huggingface-speech.ts`, `src/app/api/speech/route.ts` | Proxy con destinos fijos, referencia mexicana, límites y validación WAV |
| Texto | `src/lib/reader/text.ts` | Preparación única, citas y fidelidad de símbolos/variables |
| Archivos | `src/lib/reader/import-file.ts` | PDF/DOCX acotados, columnas conservadoras y cancelación |
| Almacenamiento | `src/lib/reader/storage.ts` | Modo temporal, borrado integral y coordinación entre pestañas |
| Servidor | `src/lib/server/http-safety.ts`, `request-guard.ts` | Origen público, destinos seguros, cuotas, tiempos y bytes |
| Verificación | `tests/`, `.github/workflows/checks.yml` | Regresiones, compilación y prueba de navegador con seguridad activa |

## Estructura y actualización

Next.js pasa de 16.2.4 a 16.4.0; React/React DOM de 19.2.4 a 19.3.0. PDF.js pasa a 6.4.299, Mammoth a 1.13.0 y NextAuth a 4.24.15. Se actualizan dependencias compatibles y el archivo de bloqueo. Node 24 es la versión de verificación y CI; se conserva el mínimo declarado de Node 22.13.

Se leen las guías instaladas de Next y se ajusta el código a la API actual de PDF.js. La instalación `npm ci` y la compilación de producción se completan. ESLint 10 funciona en esta tanda; varios plugins incluidos por Next todavía declaran rangos de peer hasta ESLint 9 y generan avisos de instalación. Es una limitación del conjunto de dependencias, no una prueba de compatibilidad con cualquier regla futura.

El modelo local Laura de 63.122.309 bytes y su configuración se retiran de los recursos publicados. Se conserva atribución, huella e historial. También se sustituye su prueba de interfaz antigua por pruebas de las voces y controles activos. Los módulos históricos de Piper permanecen fuera de la ruta de lectura actual; pueden retirarse en una limpieza posterior. `ReaderApp.tsx` sigue siendo grande: separar su transporte, ajustes e importación en componentes/hooks es una mejora pendiente de mantenimiento.

## Diseño y operabilidad

- La espera remota se muestra de forma discreta en Reproducir; no abre una ventana que interrumpa la lectura o la navegación. Pausar también puede cancelar la preparación actual.
- Los saltos dentro del WAV preparado cambian su posición sin regenerarlo. Se preparan dos ventanas siguientes y el inicio del próximo párrafo; volver a una ventana conservada reutiliza el audio. Un salto a contenido nuevo todavía puede requerir espera remota.
- El búfer vive solo en memoria, hasta 16 MiB y 32 entradas, con dos transportes simultáneos. Se vacía al cambiar documento/voz, borrar datos o desmontar el lector. Las respuestas tardías y sesiones canceladas no inician otra reproducción.
- Si falla la voz remota o `audio.play()`, se limpia el transporte anterior, cambia el selector a Dispositivo y aparece un aviso visible. Pausa/reanudación siguen el motor realmente activo.
- Se añaden selección manual de voz del dispositivo, idioma automático/español/inglés, texto al 90–125% y velocidad de 0.5–2. El menú admite teclado y conserva etiquetas/foco visibles.
- En móvil los controles siguen el orden de reproducción y el acceso a Ajustes comparte la fila superior. Pantalla completa mantiene un botón accesible para ocultar/mostrar controles y salir.
- Los segundos dentro del fragmento remoto activo usan el reloj del audio. El resaltado remoto, el tiempo restante y los saltos fuera de ese fragmento o con voz del dispositivo son estimaciones; no se presentan como alineación fonética exacta.

## Fidelidad e importación

La preparación del documento se realiza una sola vez para bloques, fragmentos y número de palabras. El reconocimiento de citas evita la expresión regular con comportamiento explosivo y conserva fechas/parentéticos que contienen información del texto. Se mantienen decimales, abreviaturas y signos de apertura en los cortes. División, potencias y comparaciones se verbalizan, sin unir variables separadas ni romper las barras de una URL o unidad compuesta.

PDF y DOCX se procesan localmente. Límite general: 25 MiB y 300.000 caracteres. PDF permite 200 páginas y 20 páginas OCR, con límites de elementos de texto, geometría, píxeles y tiempo. La extracción usa lectura progresiva y cancelación. Dos columnas se detectan de forma conservadora y requieren revisión; algunos diseños ambiguos, girados o de tres columnas se rechazan con un error útil.

DOCX valida la estructura ZIP, entradas y expansión real antes del parser: hasta 512 entradas, 32 MiB expandidos totales, 8 MiB por entrada y 4 MiB por XML/relaciones en cliente. No abre archivos externos ni incrusta imágenes. Requiere descompresión `deflate-raw` del navegador; se informa cuando no está disponible. El procesador histórico del servidor también limita la expansión ZIP y los elementos PDF.

Los cambios mejoran errores concretos de fidelidad; no garantizan que OCR, tablas o fórmulas complejas se transcriban perfectamente. Revisa nombres y cifras antes de escuchar.

## Privacidad y seguridad

Lectura temporal detiene el autoguardado durante la sesión. Borrar datos elimina estado antiguo y todas las versiones documentales de IndexedDB, detiene audio y activa lectura temporal. Solo conserva un marcador sin contenido personal que bloquea escrituras de pestañas obsoletas. Se comprueban guardados pendientes, conflicto de revisiones y recuperación explícita de un borrado interrumpido.

La voz remota transmite fragmentos a una demo pública; la aplicación no persiste modelos ni WAV. El proveedor puede conservar archivos según sus propias políticas. El lector borra el caché antiguo de Laura al abrir esta versión. Para información confidencial, evita las demos públicas; algunas voces del sistema también utilizan servicios de su proveedor.

Las rutas de procesamiento, reconstrucción y voz validan origen, MIME y tamaño antes del trabajo. El origen utiliza el `Host` HTTP público, porque Next puede construir la URL con un hostname interno; los headers forwarded no amplían los orígenes admitidos. Las cuotas y la concurrencia usan estructuras acotadas por proceso; no son autenticación ni cuotas distribuidas. La aplicación continúa siendo accesible mediante su enlace.

Se conservan validación de destinos, rechazo de IP privadas, DNS pinning y control de redirecciones. La cancelación del usuario alcanza DNS/transporte y lectura de cuerpos. La voz usa únicamente dos hosts fijos, limita tiempos/bytes, exige URLs del mismo Space y valida la integridad/estructura PCM del WAV. Las respuestas sensibles usan `no-store`.

Se añaden CSP, `nosniff`, política de referencia, bloqueo de iframes y restricciones de permisos. El shell estático de Next necesita `unsafe-inline`; no se afirma que la política elimine toda superficie XSS. No se añadieron claves de pago ni secretos al cliente.

`npm audit` pasa de 24 hallazgos (2 críticos, 16 altos, 5 moderados, 1 bajo) a **8 (0 críticos, 5 altos, 3 moderados)**. Los altos restantes pertenecen a la cadena de herramientas ESLint/Next (`braces`, `micromatch`, `fast-glob`); los moderados a Mammoth/`argparse`/`sprintf-js`. En la consulta final el registro no ofrece versiones parcheadas compatibles para esas dos cadenas: `audit fix --force` propone retroceder Next/Mammoth a versiones antiguas. No se aplica ese retroceso ni se ocultan los avisos. Los límites añadidos no equivalen a corregir esas dependencias; se mantienen como seguimiento pendiente.

## Voces de Hugging Face y límites reales

| Opción | Evidencia y motivo | Limitación |
| --- | --- | --- |
| Dispositivo | Ruta gratuita inicial, sin descarga de modelo; preferencia por voces es-MX disponibles y elección manual | Calidad, disponibilidad y posible servicio remoto dependen del equipo |
| México · HF | Demo oficial de Chatterbox es-MX/LatAm, referencia `es_mx_f1.wav` obtenida de `/config`; licencia del modelo MIT | Modelo grande alojado con GPU, demo compartida; no hay comparación audible que pruebe que sea la mejor voz |
| Dora · HF | Kokoro `ef_dora`, catálogo oficial femenino español; demo comunitaria verificada y licencia del modelo Apache 2.0 | Acento mexicano no confirmado; disponibilidad depende de la demo comunitaria |

Las dos demos permitieron generar y descargar WAV sin token en las pruebas de investigación. Una frase pública tardó aproximadamente 9 segundos hasta generación y 12 segundos hasta descarga en ese entorno. Chatterbox requirió enviar su referencia no nula; usar el valor por defecto de `/info` no funcionó. Estos tiempos no son una medición de tu equipo ni de lectura prolongada.

No son APIs de streaming: un fragmento se entrega cuando termina su generación. ZeroGPU tiene cola/cuota; un modelo abierto no garantiza alojamiento gratuito, ilimitado y continuo. El búfer reduce esperas al navegar por lo preparado, pero no hace instantáneo un fragmento desconocido. La calidad y el acento deben probarse escuchando desde la aplicación; no se atribuye identidad ni procedencia de entrenamiento a una voz por el nombre de su archivo.

Fuentes primarias y enlaces de las demos: sección Voces del `README.md`. No se utilizó una lista de terceros como prueba de disponibilidad o de calidad audible.

También se revisaron otras tres familias, sin incorporarlas como servicios activos:

| Candidata | Lo comprobado en su documentación | Motivo para no integrarla ahora |
| --- | --- | --- |
| [MMS argentino de ylacombe](https://huggingface.co/ylacombe/mms-spa-finetuned-argentinian-monospeaker) | Español argentino, VITS de 83 M parámetros, ejemplos Python/Transformers.js, licencia CC BY-NC 4.0 | La ficha no proporciona un Inference Provider; ejecutar el ejemplo JS volvería a descargar un modelo, contrario a la preferencia actual |
| [Coqui XTTS-v2](https://huggingface.co/coqui/XTTS-v2) | Español, referencia de voz, audio 24 kHz y ejemplos de motor Python; licencia CPML | No trae una narradora mexicana concreta garantizada ni un Inference Provider; requiere motor separado y referencia autorizada |
| [Qwen3-TTS VoiceDesign](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign) | Español y control por instrucciones, licencia Apache 2.0; ejemplos de PyTorch/CUDA | No tiene Inference Provider para este checkpoint; fidelidad mexicana y rendimiento en el equipo del usuario no comprobados |

Consulta de estas tarjetas primarias: 10 de octubre de 2026. Sus capacidades declaradas no constituyen una prueba audible ni justifican anunciar un servidor gratuito y continuo.

## Verificación de esta tanda

- **294 pruebas automatizadas aprobadas**, sin fallos ni omisiones: texto/rendimiento, importación, almacenamiento, motores históricos, caché offline, servidor, límites del proxy y búfer.
- ESLint y compilación de producción correctos. `npm ci` repetido satisfactoriamente. La compilación incluye `/api/speech` y genera 16 recursos de núcleo offline, aproximadamente 1,11 MB; no incluye modelos.
- Chromium con seguridad activa, perfiles aislados a 1280×900 y 390×844: transporte con WAV reproducido realmente, pausa/reanudación, velocidad, saltos de línea y párrafo preparados sin repetir su petición, respaldo tras rechazo de reproducción, pantalla completa, lectura temporal y borrado. Sin errores JavaScript/CSP ni peticiones de modelos. Los WAV de esta prueba son sintéticos; no acreditan calidad de voz.
- Se consulta la API real antes de simular audio: una petición del mismo origen llega a validación de voz y retorna 400 para una voz inválida. La comprobación encontró y corrigió el problema de hostname interno de Next.
- Prueba PWA: recarga offline servida por el service worker, preparación local de texto, icono y puntuación conservados, sin POST API.
- La prueba local del proxy falló al validar DNS de los Spaces (`EAI_AGAIN`). Una conexión HTTPS convencional posterior sí respondió 200, pero no acredita el transporte con validación/pinning. La integración final debe comprobarse desde Vercel; el fallo local no se presenta como una generación satisfactoria.
- No se han probado Android/iOS físicos, voces de cada sistema, documentos privados del usuario ni todas las composiciones PDF/OCR posibles.

Un build local no acredita que la versión esté activa en el dominio; las siguientes comprobaciones se hicieron sobre producción.

El primer commit de código es `3a7bfba69aad6c114ed44c0bd90a0a6510781cb9`. GitHub Actions completó instalación, tests, lint, build limpio y navegador satisfactoriamente en el job `114093860849`. El primer intento de Vercel compiló Next correctamente, pero su postbuild no encontró el HTML en la ruta antigua del generador; se corrige la compatibilidad del precache con el adapter actual sin omitir la verificación de integridad ni la condición de shell estático.

La corrección se verificó en una compilación limpia con un adaptador temporal real de Next 16.4. El generador original reprodujo exactamente el error `ENOENT`; el corregido terminó con código 0 y generó los 16 recursos. El HTML y el favicon coinciden por hash con los outputs actuales de `server/route-cache`. Cuatro regresiones adicionales comprueban ambos layouts, rutas agrupadas, archivos residuales, outputs ausentes y rechazo de shells incompletos/ISR/error. No se añadió el adaptador temporal a la configuración del repositorio.

## Comprobación de producción

El commit de corrección `9cc4e1a49a02e1277b62d304e80a202cfda77b04` llegó a **READY** en Vercel, despliegue `dpl_43uVE7zKMqsnL9ydJhSjFiLj37Bs`, y se asignó a [la aplicación](https://aplicacionparaleerenvozalta.vercel.app/). [GitHub Actions](https://github.com/raulmormen75/aplicacion_lectura_en_voz_alta/actions/runs/38012709071) completó instalación, 294 pruebas, lint, build y navegador con resultado satisfactorio.

La API `/api/speech` del dominio publicado devolvió 400 para una voz inválida y 200 para ambas voces reales, con `audio/wav` y `no-store`. Para una frase pública de 11 palabras, México tardó 7,566 s y Dora 6,783 s; los WAV PCM mono de 24 kHz contienen 3,760 s y 3,008 s de audio no silencioso, respectivamente. Son dos mediciones puntuales, no una garantía de latencia, continuidad ni calidad audible.

En la interfaz publicada se activó lectura temporal antes de pegar texto de prueba. México y Dora llegaron a reproducción y fin/pausa sin avisos de error; el salto de línea con audio preparado mantuvo la reproducción y no abrió un diálogo. La pausa conservó la posición. Se corrigió además el texto de estado que afirmaba «avance guardado» al pausar/reiniciar aunque la sesión fuese temporal; estos mensajes describen ahora únicamente el estado de reproducción.

El dominio responde 200 y sirve CSP, `nosniff` y `X-Frame-Options: DENY`. Los **16 recursos del manifiesto offline publicado**, 1.110.195 bytes en este build de Vercel, se descargaron y todos coincidieron con sus hashes. La recarga PWA realmente sin conexión se verificó en los perfiles aislados de navegador/CI; no se simula haber puesto sin conexión el navegador de producción.

[Captura de la interfaz publicada](docs/verification/en-voz-produccion-1791595494922.jpg), tomada sobre el commit `9cc4e1a` después de las pruebas reales de ambas voces. Los registros del navegador no mostraron errores propios de la aplicación; aparecieron errores de metadatos de una extensión del navegador, ajenos al código del lector.
