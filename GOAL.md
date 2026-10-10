# Objetivo: reproducción fluida para uso personal

Mejorar En voz y publicar cambios comprobados en GitHub y Vercel.

Las indicaciones del 9 de octubre de 2026 en México sustituyen la integración de Hugging Face por voces del dispositivo en español. El informe `INFORME_MEJORAS_2026_10_10.md` conserva los resultados de la etapa anterior; README describe el funcionamiento actual.

## Condiciones actuales

- Mostrar en el botón inferior todas las voces en español que exponga el navegador, con México primero y sin explicaciones técnicas en el menú.
- Actualizar la detección al abrir la aplicación, abrir el menú, volver a la pestaña y mediante Actualizar voces.
- No utilizar Hugging Face, Azure ni APIs de pago para reproducir documentos.
- No descargar ni guardar modelos de voz en el navegador.
- Quitar la ventana de ajustes, el selector de idioma, el interruptor temporal y sus avisos informativos.
- Colocar el tamaño del texto en los controles inferiores y en pantalla completa.
- Guardar automáticamente documento, avance y preferencias en el mismo navegador, sin avisos en el funcionamiento normal.
- Mantener saltos por línea y párrafo sin diálogos de preparación, además de pausa, reanudación y cambio de velocidad.
- Alinear etiquetas y controles, y comprobar escritorio y móvil.
- Conservar las protecciones de importación y de los endpoints documentales.
- Reconstruir localmente títulos, subtítulos, párrafos, líneas y listas de PDF, usando etiquetas fiables o geometría; preservar párrafos y cajas de OCR cuando existan.
- Mostrar durante la importación de PDF un aviso central con el fondo desenfocado, avance, Cancelar/Escape y aclaración de las posibles diferencias de fidelidad. Conservar el documento anterior ante cancelación o error.

## Verificación para publicar

- Pruebas de catálogo en español, selección manual y ausencia de respaldo en inglés.
- Pruebas de recuperación del documento, avance y preferencias.
- Análisis estático y compilación de producción.
- Comprobaciones en navegador aislado a 1280, 914, 390 y 320 px, incluida pantalla completa.
- Pruebas de estructura y orden de PDF, límites y conservación de bloques e índices; PDFs auténticos sintéticos en navegador a 914 y 390 px, incluidos aviso, cancelación, autoguardado, recarga e integración OCR.
- Commit y actualización de GitHub sin sobrescribir cambios ajenos.
- Comprobar que Vercel publique el commit y que el dominio responda.

La aplicación solo puede utilizar las voces que el navegador le entregue. No puede instalar voces ni garantizar una voz mexicana, calidad natural o funcionamiento sin conexión en todos los equipos.

Este archivo conserva el objetivo del proyecto. La activación nativa de `/goal` depende del cliente Codex.
