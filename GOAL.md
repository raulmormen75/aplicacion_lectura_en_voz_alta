# Objetivo: lectura fluida para uso personal

Mejorar En voz, corregir el diagnóstico y publicar cambios verificados en GitHub y Vercel.

Verificación de producción completada el 10 de octubre de 2026 UTC (9 de octubre en México): commit `9cc4e1a`, Vercel READY, CI satisfactoria y ambas voces remotas devuelven audio real. Evidencias, tiempos y mejoras pendientes en `INFORME_MEJORAS_2026_10_10.md`.

## Condiciones

- Navegar entre líneas y párrafos sin diálogos de preparación de voz.
- No descargar ni guardar modelos de voz automáticamente en el navegador.
- Mantener una ruta gratuita de lectura con las voces disponibles del dispositivo.
- Evaluar voces femeninas de Hugging Face, dando preferencia a México y Latinoamérica, sin Azure ni servicios de pago.
- Ofrecer voces remotas únicamente cuando su API se haya probado, indicando sus límites y el envío de fragmentos al proveedor.
- Reutilizar audio preparado, anticipar fragmentos próximos y descartar respuestas de una reproducción cancelada.
- Corregir la fidelidad del texto, importación, controles, accesibilidad, privacidad y seguridad.

## Verificación para publicar

- Pruebas de regresión de texto, límites de importación, almacenamiento y reproducción.
- Análisis estático y compilación de producción satisfactorios.
- Comprobar la navegación, pausa/reanudación, voz de respaldo y uso temporal en navegador.
- Commit y actualización de GitHub sin sobrescribir cambios ajenos.
- Comprobar que Vercel publique el commit y que la aplicación responda.

Las demos gratuitas compartidas pueden tener colas, cuotas o interrupciones. La documentación de un modelo no prueba su calidad audible ni garantiza un servicio de lectura continua. Las conclusiones y verificaciones reales de esta iteración se registran en el informe de cambios.

Este archivo conserva el objetivo del proyecto. La activación nativa de `/goal` depende del cliente Codex y no se simula mediante este archivo.
