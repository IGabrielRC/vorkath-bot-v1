# 01 — Producto

## 1. Definición

Vorkath V2 es el sistema operacional de Gabriel y Edward para administrar clientes, cuentas y perfiles de servicios digitales, renovaciones, inventario, incidencias de proveedor, mensajes de atención y control financiero.

Telegram es la interfaz principal para ejecutar operaciones con rapidez. Un panel web existente, desarrollado por separado, utilizará el mismo backend/dominio y la misma base de datos. Su construcción no forma parte del alcance actual de OpenCode + Gentle-AI para Vorkath Telegram/backend.

## 2. Problema que resuelve

El sistema actual funciona, pero distribuye identidad, inventario, ventas, sesiones y finanzas entre filas y workflows. Esto dificulta:

- saber con certeza qué cliente usa qué perfil;
- distinguir cuenta, perfil, suscripción y pago;
- corregir sin perder historial;
- ejecutar una operación crítica de forma atómica;
- auditar revelaciones de credenciales y movimientos financieros;
- mantener un núcleo técnico que no quede innecesariamente rígido, sin ampliar el alcance funcional actual más allá de Netflix y FlujoTV.

V2 debe conservar el comportamiento útil y reemplazar el acoplamiento a Sheets/n8n por un dominio explícito.

## 3. Objetivos

1. Convertir PostgreSQL en fuente de verdad después de un corte controlado.
2. Reducir el tiempo y los mensajes necesarios para cada operación.
3. Preguntar solamente datos faltantes.
4. Evitar asignaciones dobles, liberaciones automáticas y sobreescrituras silenciosas.
5. Mantener trazabilidad de acciones críticas, credenciales, inventario y dinero.
6. Evitar acoplamientos técnicos innecesarios, sin diseñar ni implementar comportamiento para otros servicios en esta versión.
7. Preparar aislamiento por organización sin construir todavía un SaaS completo.
8. Mantener costo adicional de infraestructura en $0 usando el VPS existente y componentes autoalojados.

## 4. Actores

### 4.1 OWNER

Gabriel y Edward son `OWNER`. Ambos poseen los mismos permisos funcionales en V2.

Un OWNER puede:

- consultar y revelar credenciales;
- vender, renovar, corregir y liberar;
- registrar cambios de contraseña;
- operar inventario e incidencias;
- registrar pagos y movimientos;
- preparar y confirmar cierres;
- administrar configuración de precios, costos, plantillas y umbrales.

### 4.2 Trabajador futuro

El modelo puede admitir usuarios con permisos limitados después. No se deben construir ahora jerarquías complejas, aprobación multinivel ni un editor genérico de roles.

### 4.3 Cliente

El cliente no usa Vorkath directamente en el alcance inicial. Recibe comunicaciones preparadas por Vorkath a través de WhatsApp operado por Gabriel o Edward.

## 5. Alcance funcional inicial

### 5.1 Incluido

- clientes y relación muchos-a-muchos con teléfonos;
- Netflix y FlujoTV como únicos servicios del alcance funcional actual;
- cuentas, perfiles/slots, credenciales y países de cuenta;
- ubicación del cliente separada del país de la cuenta;
- asignaciones/suscripciones y vencimientos;
- ventas nuevas y renovaciones independientes, una suscripción/servicio por operación;
- búsqueda por teléfono y por usuario/correo de cuenta;
- selección de inventario según reglas del servicio;
- liberación manual con verificación de credencial cuando aplique y Seguimiento automático para la asignación vencida liberada;
- incidencias Netflix/proveedor, garantía y reemplazos;
- tasa diaria y resumen matutino;
- plantillas y enlaces directos `wa.me` con teléfono y mensaje completo prellenado, incluidos datos de acceso cuando corresponda, sin envío automático;
- código/información de instalación FlujoTV mediante lenguaje natural y acción contextual;
- Caja, pagos, receptores, Bolsas, costos y cierre semanal;
- sesiones conversacionales persistentes y borradores;
- auditoría y seguridad;
- contrato de dominio/backend reutilizable por el panel web desarrollado por separado, sin construir su frontend.

### 5.2 Fuera de alcance inicial

- SaaS multicliente completo, facturación del SaaS o autoservicio de organizaciones;
- portal del cliente final;
- envío automático de WhatsApp;
- ejecución automática de acciones críticas;
- migración en vivo durante el desarrollo;
- dual-write inicial;
- reproducción 1:1 de las hojas o workflows;
- roles avanzados para trabajadores;
- frontend, UX o implementación del panel web;
- comportamiento concreto para Disney+, Max, Prime Video u otros servicios;
- contabilidad fiscal formal;
- integración bancaria automática;
- alta disponibilidad empresarial.

## 6. Servicios iniciales

### 6.1 Netflix

- Una cuenta posee credenciales, país, proveedor, ciclo de proveedor y slots/perfiles.
- Los perfiles 1–4 son comerciales.
- El perfil 5 es de emergencia.
- La asignación automática prioriza cuentas activas parcialmente ocupadas, luego cuentas totalmente libres y, solo sin inventario comercial, el perfil de emergencia con confirmación.

### 6.2 FlujoTV

- Admite cuentas compartidas con varios clientes.
- Admite cuentas completas/exclusivas para un único cliente.
- Cada cuenta registra `PAIS_CUENTA`.

### 6.3 Límite y propiedad técnica de extensibilidad

El dominio debe separar servicio, modalidad, cuenta y slot para evitar rigidez innecesaria. Esta propiedad técnica no amplía el alcance: V2 actual solo define Netflix y FlujoTV. No deben crearse flujos, reglas, planes, pantallas ni pruebas específicas para Disney+, Max, Prime Video u otros servicios.

## 7. Capacidades principales

| Capacidad | Resultado esperado |
|---|---|
| Venta | Borrador completo, asignación válida, pago registrado y trazabilidad. |
| Renovación | Extensión de una sola suscripción/servicio por operación, con borrador, pago, Caja, auditoría y confirmación propios. |
| Consulta | Ficha clara por teléfono, cliente o cuenta, sin revelar más de lo necesario. |
| Inventario | Disponibilidad real; vencido no equivale a libre. |
| Incidencia | Pausa/garantía/reemplazo sin destruir historia. |
| WhatsApp | Botón directo al chat con mensaje completo prellenado y específico del cliente; el estado nunca afirma envío automático. |
| Caja | Libro de movimientos con operador y receptor diferenciados. |
| Cierre | Cálculo semanal revisable y confirmación manual. |

En una búsqueda normal por teléfono sin coincidencias, el producto solo informa “no encontrado” y permite intentar otro número o volver. La creación de cliente se reserva al flujo explícito de Venta nueva.

Si Venta nueva no encuentra inventario, solo informa `No hay inventario disponible.` y puede ofrecer revisar inventario, volver o cancelar. No crea Seguimiento, lista de espera, cliente pendiente, reserva ni asignación ficticia.

## 8. Requisitos no funcionales

- **Velocidad:** las lecturas operacionales frecuentes deben sentirse inmediatas y los flujos comunes requerir el mínimo de turnos.
- **Atomicidad:** ventas, renovaciones, liberaciones, cambios de contraseña, reemplazos y cierres deben confirmarse completos o no aplicarse.
- **Idempotencia:** reintentos y doble pulsación no deben duplicar ventas, pagos ni movimientos.
- **Persistencia operacional:** un borrador iniciado no expira por inactividad; permanece hasta confirmación o cancelación explícita, aunque sus botones deban regenerarse.
- **Trazabilidad:** cada operación crítica identifica organización, actor, hora, origen, borrador confirmado y resultado.
- **Seguridad:** mínimo privilegio, cifrado reversible de credenciales de servicio y hashing de autenticación propia.
- **Disponibilidad razonable:** diseño apropiado para un VPS pequeño, con procesos simples de backup y restauración probados.
- **Consistencia:** el backend concentra las reglas para que Telegram y el panel desarrollado por separado no las dupliquen.
- **Configurabilidad:** precios, costos, umbrales, plantillas, horarios y repartos no se codifican como constantes.
- **Localización:** mensajes en español y manejo explícito de zona horaria/moneda.

## 9. Indicadores de éxito

- porcentaje de operaciones completadas sin reingresar datos ya conocidos;
- mediana de turnos por venta, renovación y consulta;
- cero asignaciones simultáneas de un slot exclusivo;
- cero liberaciones automáticas por vencimiento;
- cero operaciones críticas duplicadas por reintento;
- reconciliación del 100% de registros críticos durante migración;
- restauración de backup ensayada antes de corte;
- capacidad de explicar quién hizo, confirmó y recibió cada movimiento financiero.

## 10. Criterio de producto terminado para V2 inicial

V2 inicial está listo para considerar corte cuando:

1. todos los flujos críticos funcionan con datos falsos;
2. las reglas pendientes que bloquean cálculos o migración están resueltas;
3. el modelo y las restricciones impiden estados inválidos;
4. la auditoría cubre credenciales y finanzas;
5. backups y restauración fueron probados;
6. la importación de ensayo concilia conteos, relaciones y saldos;
7. Gabriel y Edward aprueban Telegram con escenarios reales simulados;
8. existe un procedimiento de reversa practicado.

## 11. Pendientes de producto

- Definir si Netflix cuenta completa entra al alcance comercial inicial y con qué precio/costo.
- Confirmar continuidad de promociones FlujoTV 6→7 y 12→14 meses.
- Confirmar continuidad de la derivación del PIN Netflix desde el teléfono.
- Definir política de pagos divididos.
- Definir zona horaria operacional contractual.
