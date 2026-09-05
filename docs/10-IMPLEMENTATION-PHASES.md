# 10 — Fases de implementación

**Ecosistema exclusivo de implementación:** OpenCode + Gentle-AI.

Estas fases expresan dependencias de producto, orden lógico y criterios de aceptación. No sustituyen ni imponen un workflow paralelo a la orquestación, exploración, SDD/RDD, implementación, verificación o evidencia administradas por Gentle-AI.

## 1. Principios de ejecución

- Construir desde el dominio, no desde los workflows.
- Mantener V1 intacto.
- Usar datos falsos hasta la fase de migración autorizada.
- Entregar verticales pequeñas verificables.
- No avanzar una puerta con secretos, finanzas o asignaciones sin pruebas.
- Resolver decisiones pendientes antes de la fase que dependa de ellas.

## 2. Fase 0 — Aprobación de especificación

### Trabajo

- revisión conjunta de los doce documentos;
- resolver contradicciones y pendientes bloqueantes;
- acordar vocabulario y estados;
- convertir reglas `BR-*` en matriz de pruebas.

### Puerta

- Gabriel y Edward aprueban reglas de inventario, fechas, precios/costos, pagos y cierre.
- No quedan pendientes que impidan modelar o calcular.

## 3. Fase 1 — Esqueleto seguro y entorno aislado

### Trabajo

- estructura del backend y configuración por entorno;
- PostgreSQL solo de desarrollo;
- migraciones técnicas del esquema objetivo;
- secretos de prueba;
- logs con redacción;
- health checks;
- pipeline de pruebas y escaneo de secretos.

### Prohibiciones

- no conectar Sheets/n8n productivos;
- no usar teléfonos, cuentas ni contraseñas reales;
- no desplegar base de producción.

### Puerta

- un entorno limpio se crea con datos ficticios;
- logs no exponen secretos de prueba;
- configuración de producción no está disponible al entorno.

## 4. Fase 2 — Identidad, organización y auditoría base

### Trabajo

- organización inicial;
- usuarios y rol OWNER;
- vínculo Telegram↔usuario;
- autorización central;
- eventos de auditoría y correlación;
- idempotencia de comandos.

### Pruebas

- Gabriel/Edward ficticios tienen permisos equivalentes;
- identidad desconocida es rechazada;
- aislamiento de organización;
- doble request no duplica evento crítico.

### Puerta

- ninguna ruta posterior puede evitar identidad, organización y auditoría.

## 5. Fase 3 — Clientes, teléfonos y búsqueda

### Trabajo

- clientes, teléfonos y relación muchos-a-muchos;
- normalización sin destruir original;
- búsqueda directa por teléfono;
- selección si hay varios clientes;
- seguimiento.

### Pruebas

- cliente con varios teléfonos;
- teléfono con varios clientes;
- búsqueda normal sin coincidencias solo informa no encontrado y permite otro número o volver;
- búsqueda normal no crea ni ofrece crear cliente;
- número sin país o formato ambiguo;
- seguimiento sin expiración automática.

### Puerta

- la interfaz no usa teléfono como PK ni fusiona por nombre.
- la creación de cliente queda reservada al flujo explícito de Venta nueva.

## 6. Fase 4 — Catálogo, cuentas, slots y credenciales

### Trabajo

- Netflix y FlujoTV como únicos servicios/planes funcionales actuales;
- cuentas y país de cuenta;
- proveedores/ciclos básicos;
- slots comerciales/emergencia/exclusivos;
- cifrado/versionado de credenciales;
- búsqueda por cuenta;
- la búsqueda por correo/usuario muestra primero la cuenta, con slots, clientes y disponibilidad debajo;
- disponibilidad derivada;
- código/información de instalación FlujoTV por lenguaje natural y botón contextual.

### Pruebas

- Netflix perfiles 1–4 y emergencia 5;
- FlujoTV compartida/completa;
- credencial no visible en base/logs;
- revelación auditada;
- un cambio conserva versión anterior/nueva como metadatos sin exigir el secreto recuperable anterior;
- vencido asignado no queda disponible.

### Puerta

- restauración de una copia de base no permite leer secretos sin llave;
- restricciones impiden doble asignación.

## 7. Fase 5 — Sesiones, borradores y UX Telegram de lectura

### Trabajo

- sesiones persistentes;
- contexto/versiones de listas;
- interpretación de lenguaje y botones;
- menú principal pequeño y acciones contextuales que comparten estado con el lenguaje natural;
- ayuda, búsqueda, disponibilidad, vencidos y tasa de prueba;
- confirmación/cancelación explícitas de operaciones;
- expiración segura de callbacks con regeneración de botones, sin expirar el borrador.

### Pruebas

- “la 2” solo funciona en su lista;
- botón antiguo se rechaza;
- botón expirado recupera el borrador y genera opciones vigentes;
- operación inactiva continúa pendiente hasta confirmación o cancelación explícita;
- comando de lectura no destruye borrador compatible;
- una frase completa pregunta solamente campos faltantes;
- una corrección conversacional modifica y recalcula el borrador sin reiniciarlo;
- vencidos incluye 0 y negativos, agrupa Netflix/FlujoTV, ordena del más antiguo al reciente y no libera inventario;
- no se muestran contraseñas en listas.

### Puerta

- consultas frecuentes funcionan sin escrituras de negocio.

## 8. Fase 6 — Venta nueva vertical

### Trabajo

- políticas de precio versionadas;
- selección priorizada de inventario;
- borrador/resumen/corrección/confirmación;
- operación, asignación, pago y movimientos atómicos;
- respuesta y mensaje preparado.

### Pruebas

- mensaje completo pregunta solo lo faltante;
- un cliente inexistente puede crearse únicamente dentro de esta Venta nueva confirmada;
- inventario comercial antes de emergencia;
- emergencia requiere confirmación especial;
- cambio de inventario invalida borrador;
- sin inventario solo informa, permite revisar/volver/cancelar y no crea cliente pendiente, Seguimiento, lista de espera, reserva ni asignación;
- doble confirmación crea una venta;
- error financiero revierte asignación.

### Puerta

- venta completa demostrada con datos ficticios y auditoría.

## 9. Fase 7 — Renovaciones individuales

### Dependencias de decisión

- base de fecha;
- fin de mes;
- prorrateo diario;
- promoción FlujoTV;
- Netflix completa si aplica.

### Trabajo

- selección por teléfono/servicio;
- meses/días;
- una suscripción/servicio por operación;
- encadenamiento UX opcional para iniciar otra renovación solo después de terminar la anterior;
- fecha anterior/nueva;
- pago, Caja, auditoría e idempotencia propios;
- corrección y atomicidad.

### Pruebas

- teléfono largo no se interpreta como tiempo;
- varias suscripciones exigen selección de una para el borrador actual;
- solicitar Netflix y FlujoTV produce dos borradores, confirmaciones, pagos, movimientos, eventos y transacciones independientes;
- no existe `RENOVACION_MULTIPLE`, `Todas`, pago consolidado ni rollback conjunto;
- el fallo de una renovación no revierte otra ya confirmada;
- costo/precio guardan versiones;
- vencido respeta base de fecha aprobada.

### Puerta

- matriz de bordes de fechas aprobada.

## 10. Fase 8 — WhatsApp, contraseña y liberación

### Trabajo

- plantillas versionadas;
- enlace directo `wa.me` con teléfono y mensaje completo prellenado, incluidos datos de acceso vigentes cuando corresponda;
- un botón y mensaje específico por cliente activo afectado;
- plantillas configurables para acceso, vencimiento, renovación, contraseña, correo/usuario, perfil y reemplazo;
- auditoría de credenciales;
- cambio de contraseña con afectados;
- liberación manual que verifica la credencial vigente o prepara su actualización en el borrador antes del resumen/confirmación;
- detección de una credencial ya actualizada desde otra interfaz;
- Seguimiento automático al liberar una asignación vencida.

### Pruebas

- abrir enlace no marca enviado;
- WhatsApp abre directamente el chat correcto con el texto completo, sin copiar/pegar, portal ni página intermedia;
- URL completa y cuerpo sensible no quedan en logs, auditoría ni analytics;
- cambio registra versión anterior/nueva sin requerir la contraseña antigua recuperable y genera acciones para afectados;
- liberación no borra historia;
- vencimiento no libera;
- liberar un vencido deja de ocupar inventario, deja de aparecer como vencido activo y crea Seguimiento sin preguntar;
- credencial ya actualizada no se solicita otra vez;
- ninguna liberación/cambio crítico se ejecuta sin confirmación;
- logs sin secretos.

### Puerta

- revisión de seguridad específica aprobada.

## 11. Fase 9 — Incidencias, garantía y reemplazos

### Trabajo

- abrir caída Netflix;
- reemplazo total/parcial;
- `Esperar por proveedor`;
- pausa/reanudación de ciclo;
- cuenta anterior/nueva;
- mensajes de reemplazo.

### Pruebas

- espera no consume inventario;
- incidencia permanece abierta;
- reemplazo conserva historia;
- cuenta esperando proveedor no aparece disponible;
- operación parcial fallida revierte.

### Puerta

- escenarios de garantía aprobados por ambos OWNER.

## 12. Fase 10 — Caja, Bolsas y cierre

### Dependencias de decisión

- pagos divididos;
- prorrateo diario;
- fees y saldo negativo;
- USD/USDT en reportes;
- crédito FlujoTV.

### Trabajo

- libro de movimientos;
- custodios/receptores;
- Bolsas persistentes;
- costos variables/recurrentes;
- adquisiciones sin doble costo;
- transferencias y conversión;
- vista semanal;
- flujo de cierre de 16 pasos;
- ajustes posteriores.

### Pruebas

- operador ≠ receptor;
- saldos derivados;
- transferencia conserva dos lados y tasa real;
- compra de cuenta no duplica costo semanal;
- cierre inmutable y ajuste enlazado;
- semana lunes–domingo;
- terminar el domingo no cierra; el aviso de semana pendiente es informativo y la confirmación puede hacerse posteriormente.

### Puerta

- conciliación manual de escenarios ficticios coincide al centavo/unidad definida.

## 13. Fase 11 — Jobs y resiliencia

### Trabajo

- tasa diaria con 3 intentos/3 segundos;
- entrada manual y notificación;
- resumen matutino;
- umbrales de inventario;
- monitoreo, alertas y recuperación de jobs.

### Pruebas

- fallo total notifica a ambos;
- tasa anterior no se usa ni etiqueta como actual y el fallo total solo ofrece reintentar o ingresar manual;
- reintento no crea duplicado;
- resumen no ejecuta acción crítica;
- ninguna notificación automática vende, renueva, libera, reemplaza, cambia credenciales, cierra Caja, mueve dinero ni paga costos;
- job omitido genera alerta.

### Puerta

- zona horaria y calendario aprobados.

## 14. Restricción de integración futura — Panel web

El panel web existe y se construye por separado. OpenCode + Gentle-AI no debe implementar su frontend, pantallas ni UX dentro del alcance actual de Vorkath Telegram/backend.

El backend/dominio sí debe:

- concentrar las reglas compartidas;
- usar PostgreSQL como única fuente de verdad después del corte;
- exponer contratos que el panel pueda consumir posteriormente;
- impedir que Telegram o el panel escriban directamente en tablas o dupliquen reglas;
- conservar autorización, auditoría e idempotencia independientemente del canal.

## 15. Fase 12 — Preparación operacional

### Trabajo

- backups cifrados;
- restauración ensayada;
- monitoreo de disco/servicios;
- runbooks de incidente;
- revisión de dependencias y configuración;
- carga y rendimiento apropiados al VPS.

### Puerta

- RPO/RTO/retención definidos;
- restauración conciliada;
- alertas llegan a responsables;
- no hay secretos en repositorio/logs.

## 16. Fase 13 — Migración de ensayo

Seguir `09-MIGRATION-PLAN.md`:

- perfilado read-only;
- diccionario/mapeo;
- importador repetible;
- exportación real controlada;
- base aislada;
- conciliación y excepciones.

### Puerta

- 100% de registros críticos migrados o exceptuados de forma aprobada;
- finanzas y asignaciones conciliadas;
- secretos protegidos.

## 17. Fase 14 — Corte y estabilización

- ventana y congelación;
- exportación final;
- backup;
- importación/validación;
- `GO/NO-GO`;
- V2 única escritura;
- Sheets read-only;
- monitoreo y estabilización;
- retiro separado posterior.

## 18. Estrategia de pruebas transversal

### Unitarias de dominio

Reglas `BR-*`, fechas, prioridades, costos, estados y autorización.

### Integración

Transacciones, restricciones, cifrado, idempotencia y jobs.

### Contrato

Telegram contra las operaciones del backend y contrato documentado para que el panel construido por separado consuma el mismo dominio. La implementación/prueba de su UI no pertenece a este plan.

### Escenarios end-to-end

Venta, renovaciones individuales secuenciales, WhatsApp directo, cambio de contraseña/correo/perfil, liberación, incidencia/reemplazo, pago/cierre y migración.

### Seguridad

Aislamiento, acceso denegado, callbacks antiguos, redacción, backup/restore y secretos.

## 19. Definición de terminado por fase

Una fase termina solo si:

- criterios funcionales y negativos pasan;
- reglas afectadas están citadas;
- auditoría y seguridad fueron verificadas;
- documentación se actualizó;
- no introdujo acceso productivo no autorizado;
- los fallos no dejan escrituras parciales;
- Gabriel/Edward pueden validar el flujo cuando corresponde.

## 20. Orden de dependencias que OpenCode + Gentle-AI no debe alterar sin decisión

Identidad y auditoría preceden credenciales; inventario precede ventas; ventas preceden renovaciones; libro financiero precede cierre; backup/restauración preceden migración; ensayo precede corte.

Cambiar este orden exige justificar riesgos y actualizar el plan antes de implementar.
