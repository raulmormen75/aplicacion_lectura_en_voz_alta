# Diagnóstico y actualización del lector

Fecha de revisión: 16 de septiembre de 2026.

## Alcance y criterio de cierre

Actualizar la aplicación existente, conservar documentos y preferencias, corregir errores funcionales y de presentación y comprobar la versión publicada en Vercel. Un resultado local o una compilación correcta no acreditan el despliegue. Este diagnóstico se actualiza con evidencia; la revisión integral sigue EN CURSO.

Restricción confirmada: conservar todas las funciones y herramientas actuales. No sustituir los dos modelos de voz, retirar controles ni reducir opciones para facilitar las pruebas.

## Estado comprobado

- Next.js 16.2.4, React 19.2.4, TypeScript, aplicación instalable.
- Repositorio: https://github.com/raulmormen75/aplicacion_lectura_en_voz_alta.
- Vercel: proyecto `aplicacion_para_leer_en_voz_alta`, conectado al repositorio anterior.
- `npm audit --json`: cero vulnerabilidades reportadas en esta revisión. Esto no sustituye la auditoría del código ni prueba ausencia de vulnerabilidades.
- Motores presentes: Web Speech API y Piper local. El README anterior describe únicamente el primero y requiere actualización.

## Dictamen inicial

| Prioridad | Hallazgo y fuente revisada | Consecuencia | Corrección y estado |
| --- | --- | --- | --- |
| Alta | `ReaderApp.tsx`, efecto de persistencia; `storage.ts`, `saveReaderState`: serializan documento y progreso en cada actualización, sin controlar errores de cuota | Bloqueos con documentos largos; fallo de guardado sin aviso | Separar documento y progreso; persistencia tolerante a errores. PENDIENTE |
| Alta | `api/documents/process/route.ts`, `extractWebsiteText`: descarga una dirección arbitraria sin restricciones de destino, tiempo ni tamaño | Riesgo de acceso a recursos internos y consumo excesivo | Validación del destino y redirecciones, límites y pruebas. PENDIENTE |
| Alta | `api/documents/process/route.ts`, extracción PDF: rechaza escaneados sin texto; la interfaz propone OCR, pero no hay ejecución de Tesseract | El flujo prometido no existe | Procesamiento local y OCR real con avance y cancelación. PENDIENTE |
| Alta | `ReaderApp.tsx`, eventos Piper: la velocidad original se reutilizaba al cambiar de fragmento; callbacks tardíos podían afectar otra reproducción | Audio, controles y resaltado incoherentes | Corregido localmente; compilación y prueba de arranque en navegador aprobadas. Falta publicación |
| Media | El modelo Piper devuelve audio sin marcas temporales por palabra | La estimación no garantiza sincronización exacta | Estimación ligada al reloj y actividad del audio implementada; alineación exacta NO CONFIRMADA |
| Media | `ReaderApp.tsx`, `processText`: envía texto pegado al servidor aunque las funciones de limpieza ya están disponibles en cliente | Dependencia de red innecesaria | Preparación local. PENDIENTE |
| Media | `public/sw.js`: intercepta cualquier GET y devuelve HTML como respaldo incluso para otros recursos; borra cachés ajenas a su versión | Respuestas inválidas, interferencia con recursos y cachés | Restringir alcance, conservar recursos de otras bibliotecas. PENDIENTE |
| Media | `ReaderApp.tsx`, `reconstructLegibleText`: petición sin manejo de excepción/finalización; API sin límites ni captura de errores de entrada | Interfaz puede quedar ocupada indefinidamente | Manejo de errores y límites. PENDIENTE |
| Media | `globals.css`, barra inmersiva: columnas con mínimos superiores al ancho disponible | Selector oculto y controles superpuestos | Distribución adaptable corregida localmente; verificada con tamaños emulados. Falta publicación |

Los hallazgos de código anteriores tienen soporte directo en las funciones indicadas. Su impacto en todos los dispositivos no se presume comprobado.

## Dirección de diseño

Conservar negro, grafito, marfil y dorado, con el icono aprobado. Reducir contenedores decorativos, ordenar importación, contenido y reproducción; dar prioridad al documento y a acciones alcanzables. Controles táctiles cómodos, etiquetas accesibles, foco visible, estados breves y cancelación explícita. No convertir el inicio en una página promocional.

## Matriz pendiente

- PDF digital, PDF escaneado, DOCX, texto y sitio público, con entradas inválidas y documentos extensos.
- Reproducir, pausar, reanudar, cambiar motor y velocidad, saltos y fin del contenido.
- Guardar, recargar, recuperar estado y fallar por almacenamiento restringido sin perder operabilidad.
- Escritorio, móvil vertical/horizontal y pantalla completa, navegación con teclado.
- Compilación, revisión estática, pruebas automatizadas y comprobación de la versión publicada.
- Rendimiento y voz en Android/iOS físicos: NO CONFIRMADO; la emulación no sustituye estos dispositivos.

## Avance de implementación local

Esta sección actualiza el dictamen inicial; no acredita publicación.

- Persistencia: documento en IndexedDB y avance pequeño separado; migración del formato anterior, validación de datos y avisos de fallo. Pruebas automatizadas de cuota y orden de guardado aprobadas.
- Importación: PDF, DOCX y texto se procesan en cliente. OCR local incorporado con estados y cancelación. El PDF real autorizado de Economía Digital y Mercados Emergentes se importó en el navegador sin errores de consola ni alteración del original.
- La prueba real detectó separación excesiva de párrafos y falsos encabezados. La corrección de geometría PDF y clasificación de texto ya produce párrafos continuos y un título completo en la interfaz, comprobados al volver a importar el original con la última compilación.
- Sitios web: límites de entrada y respuesta, tiempo máximo, validación de destinos y redirecciones y fijación de la dirección IP validada. Pruebas incluyen DNS privado y respuestas demasiado grandes; no equivalen a una auditoría exhaustiva de seguridad.
- Piper: ejecución serial, cancelación y descarte de callbacks tardíos, caché temporal de audio y seguimiento del reloj del audio. La primera descarga del modelo no se reduce por reutilizar fragmentos; rendimiento físico móvil PENDIENTE.
- Interfaz: selector de voz en ambos modos, controles accesibles por teclado, cancelación visible, estado vacío compacto y distribución adaptable. La revisión visual final del conjunto sigue PENDIENTE.
- Service worker: caché limitada a recursos apropiados y respaldo HTML de la raíz, sin sustituir respuestas API ni recursos de otros tipos. Pruebas de caché aprobadas; arranque real sin conexión PENDIENTE.
- `npm run lint` terminó sin errores. Última ejecución de la suite: 135 pruebas aprobadas. La compilación local posterior a las correcciones de formato y caché fue correcta.
- Pruebas reales en la aplicación local: sitio público importado, recuperación del documento tras recargar, PDF escaneado reconocido mediante OCR y DOCX con encabezados y párrafos. Sin errores de consola en esos flujos.
- Distribución comprobada con tamaños emulados de 390 px y 1440 px: sin desbordamiento horizontal del documento; botones de aproximadamente 44 px de alto. Menú de voz en pantalla completa móvil visible dentro del área disponible. No sustituye prueba física Android/iOS.
- Audio real en navegador: Piper inició desde su ventana de progreso, avanzó el porcentaje, permitió cambiar a 0.85 y pausar. El cambio posterior a Voz estándar no reanudó Piper y permitió iniciar el motor del navegador. El navegador de prueba no expone Dalia, circunstancia comunicada por la interfaz. ONNX informó ejecución con un solo hilo; esto no impidió la reproducción, pero limita el rendimiento esperable.
- GitHub: actualización funcional publicada en `main`, commit `f30c5431f3111e2d2cee3a9137ce17be14e57ca6`.
- Vercel: despliegue `dpl_7GnsPhEQaV5Hyxbtmc5DfhBQAeCA`, estado READY, asociado al commit anterior y al dominio `https://aplicacionparaleerenvozalta.vercel.app/`.
- Comprobación publicada: interfaz actualizada, PDF escaneado importado con OCR y reproducción Piper iniciada con avance visible. Sin errores en esos flujos; ONNX conserva las advertencias de un solo hilo ya descritas. La publicación no cierra los pendientes de la matriz ni acredita rendimiento físico móvil.
- Fallo detectado después del despliegue: importación web devolvía 500 solo en Vercel. Los registros del despliegue `dpl_ruYVz62sW1JF3iZ9meDt12FuQzMG` identificaron `ERR_REQUIRE_ESM` entre `html-encoding-sniffer` y `@exodus/bytes`. Reproducido localmente al desactivar require-ESM; carga y extracción aprobadas al habilitarlo. Se configura la opción en `vercel.json` y se agrega una prueba con las bibliotecas reales, sin mocks. La [documentación oficial de Vercel](https://vercel.com/docs/functions/runtimes/node-js/advanced-node-configuration#experimental-node.js-require-of-es-module) confirma que esta compatibilidad se desactiva por defecto. Validación publicada del ajuste PENDIENTE.
