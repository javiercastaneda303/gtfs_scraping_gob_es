# CLAUDE.md — Reglas del proyecto

## Proyecto
Scraping de datos GTFS desde el portal NAP (Punto de Acceso Nacional) de transporte de España (nap.transportes.gob.es). Usa Playwright para navegación, Mongoose para persistencia en MongoDB.

## Idioma
- Comunicarse siempre en español con el usuario.

## Permisos y ejecución
- Ejecutar comandos (`node`, `npm`, `npx`, shell) sin pedir confirmación.
- No hacer preguntas innecesarias. Actuar directamente.
- Si algo falla, diagnosticar y reintentar antes de preguntar.

## Stack técnico
- Node.js (CommonJS)
- Playwright (scraping con navegador)
- Mongoose / MongoDB
- dotenv para variables de entorno

## Reglas de código
- Escribir código en JavaScript (CommonJS con `require`).
- No usar TypeScript salvo indicación explícita.
- No agregar dependencias sin que el usuario lo solicite.
- Mantener los scripts simples y directos, sin abstracciones innecesarias.
- No agregar comentarios obvios ni documentación extra no solicitada.

## Git
- No hacer commits ni push a menos que el usuario lo pida explícitamente.
