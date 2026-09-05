# 03 — UX de Telegram

## 1. Contrato del canal

Telegram es una interfaz sobre el dominio, no el lugar donde viven las reglas. Toda escritura debe llamar una operación del backend con autorización, validación, transacción e idempotencia.

El bot acepta texto, comandos y callbacks. Las respuestas deben ser breves, operacionales y contextuales.

## 2. Identidad y acceso

- El identificador de Telegram se vincula a un usuario interno.
- Solo usuarios activos y autorizados acceden.
- Gabriel y Edward se vinculan a rol `OWNER`.
- Un identificador desconocido recibe una respuesta neutra y genera un evento de acceso denegado.
- Los identificadores no se codifican en lógica de negocio.

## 3. Acciones de entrada

Vorkath debe reconocer al menos:

- ayuda;
- teléfono escrito directamente;
- correo/usuario de cuenta escrito directamente;
- venta nueva;
- renovación;
- consulta de datos;
- disponibilidad/inventario;
- precios;
- tasa;
- vencidos/próximos a vencer;
- cambio de contraseña;
- liberación;
- incidencia y reemplazo;
- código FlujoTV;
- Caja, movimientos y cierre;
- cancelar, volver y corregir.

Los comandos existentes, como `/tasa` y `/vencidos`, pueden mantenerse como atajos, pero no deben ser la única forma de acceso.

El comportamiento funcional definido en este documento se limita a Netflix y FlujoTV. No se deben añadir intents ni flujos concretos para otros servicios.

### 3.1 Menú y contexto

El menú principal debe permanecer pequeño. Las acciones se presentan como botones según la entidad actual y siempre tienen equivalente conversacional sobre el mismo estado. Ejemplos:

- ficha cliente: `Renovar`, `Datos`, `WhatsApp`, `Reemplazar`, `Más`;
- cuenta Netflix: `Cambiar contraseña`, `Reemplazar`, `Ver clientes`, `Marcar caída`;
- FlujoTV: `Datos`, `Renovar`, `WhatsApp`, `Código instalación`.

No se construye un menú permanente con todas las operaciones.

### 3.2 Código de instalación FlujoTV

Vorkath conserva la consulta conversacional mediante `codigo`, `código`, `código flujo`, `dame el código` y variantes naturales equivalentes. Cuando el contexto es FlujoTV, puede mostrar `Código instalación`. Es una lectura y no requiere confirmación.

## 4. Ficha por teléfono

### Entrada

`04141234567`

### Resolución

1. Normalizar el teléfono conservando el valor original y el formato canónico.
2. Buscar relaciones activas e históricas.
3. Si no existe, responder únicamente `No encontré ningún cliente asociado a ese número.` y ofrecer `Escribir otro número` o `Volver`.
4. Si pertenece a un cliente, abrir la ficha.
5. Si pertenece a varios, mostrar selección de cliente.

Esta búsqueda normal nunca ofrece crear cliente. Un cliente nuevo solo puede crearse dentro del flujo explícito de Venta nueva, después de recopilar los datos necesarios y confirmar la operación.

### Ficha mínima

- cliente;
- teléfonos relacionados;
- ubicación;
- servicios activos y estado;
- vencimientos;
- seguimiento abierto;
- acciones: `Ver datos`, `Renovar`, `Vender`, `Liberar`, `Seguimiento`.

No mostrar contraseñas en la ficha general.

## 5. Búsqueda por cuenta

Si el usuario introduce un correo o usuario de Netflix/FlujoTV:

1. buscar `service_account` por identificador normalizado;
2. mostrar servicio, modalidad, país, estado, proveedor y ocupación;
3. listar slots/perfiles y clientes asociados;
4. ofrecer acciones contextuales.

No tratar inicialmente el correo como búsqueda de cliente. Si existen coincidencias en varios servicios, mostrar una selección sin credenciales.

## 6. Venta nueva

### 6.1 Datos del borrador

- servicio;
- modalidad;
- cliente existente o nuevo;
- nombre;
- teléfono;
- ubicación;
- duración;
- slot/cuenta a asignar;
- precio aplicado;
- monto real recibido;
- moneda;
- método de pago;
- `RECIBIDO_POR`;
- `OPERADOR` derivado de la sesión.

### 6.2 Flujo

1. Extraer todos los datos del mensaje.
2. Resolver cliente/teléfono o, solo dentro de este flujo explícito, recopilar el alta necesaria.
3. Aplicar política de inventario.
4. Preguntar solo campos faltantes.
5. Mostrar resumen.
6. Confirmar.
7. En una transacción: crear/actualizar cliente y teléfono, crear venta/suscripción, asignar slot, registrar pago/caja y auditar.
8. Generar mensaje de acceso y enlace WhatsApp.

### 6.3 Inventario de emergencia

Si solo queda perfil 5 de Netflix:

> No hay perfiles comerciales disponibles. Queda un perfil de emergencia en la cuenta ••••. ¿Deseas usarlo?

Botones: `Usar emergencia` / `Cancelar`. La confirmación normal de venta sigue siendo necesaria después.

### 6.4 Sin inventario

Responder claramente `No hay inventario disponible.` Puede ofrecer únicamente `Revisar inventario`, `Volver` o `Cancelar operación`.

No crea Seguimiento, lista de espera, cliente pendiente, reserva ni asignación ficticia. Una futura lista de espera requiere una decisión de producto nueva.

## 7. Renovación

### 7.1 Entrada completa

`renueva 04141234567 Netflix 2 meses`

Vorkath resuelve teléfono, servicio y tiempo. “Renueva” implica que el cliente pagó, pero todavía se deben registrar monto, método/moneda y receptor cuando no estén disponibles.

### 7.2 Varias suscripciones

Mostrar opciones con:

- servicio;
- modalidad/perfil;
- cuenta parcialmente enmascarada;
- vencimiento;
- estado.

Permitir seleccionar una sola suscripción para la operación actual. No ofrecer `Todas`, `renovar todas` ni una selección múltiple consolidada.

Si el cliente quiere renovar Netflix y FlujoTV, se completa y confirma primero una renovación. Después Vorkath puede preguntar `También tiene FlujoTV. ¿Deseas renovarlo?`; aceptar inicia un borrador nuevo e independiente.

### 7.3 Tiempo

Aceptar meses, días y combinaciones si la política aprobada lo permite. No confundir teléfonos, perfiles, fechas ni opciones con duración.

El cálculo exacto de base de fecha, fin de mes, promociones FlujoTV y prorrateo diario permanece `PENDIENTE DE DECISIÓN`; OpenCode + Gentle-AI no debe heredarlo automáticamente del workflow.

### 7.4 Ejecución

Cada renovación usa una transacción lógica propia para:

- crear operación de renovación;
- actualizar una suscripción;
- registrar su pago y sus movimientos;
- guardar fechas anterior/nueva;
- auditar.

No existe `RENOVACION_MULTIPLE`, pago consolidado, movimiento de Caja compartido ni rollback conjunto. El fallo de una renovación no revierte otra renovación ya confirmada.

## 8. Consulta y revelación de datos

1. Resolver teléfono/cliente/servicio.
2. Si hay varias opciones, listar sin contraseña ni PIN.
3. Tras selección, comprobar autorización.
4. Mostrar credenciales y vencimiento del servicio elegido.
5. Registrar `CREDENTIAL_REVEALED` con actor, cuenta, canal y propósito.
6. Ofrecer `Preparar WhatsApp`, `Cambiar contraseña` o `Volver`.

`PENDIENTE DE DECISIÓN`: confirmar si V2 conserva el PIN Netflix derivado del teléfono.

## 9. WhatsApp

Vorkath genera desde una plantilla versionada un enlace directo `wa.me` con el teléfono y el mensaje completo prellenado. Gabriel/Edward pulsa el botón, WhatsApp abre el chat correcto con el texto listo y el envío final se realiza manualmente.

Cuando la atención lo requiere, el texto incluye deliberadamente los datos vigentes completos: correo/usuario, contraseña, perfil, PIN si aplica y cualquier otro dato de acceso. También cubre vencimiento, renovación, cambio de contraseña, cambio de correo/usuario, cambio de perfil y reemplazo.

Si una acción afecta varios clientes activos, Vorkath presenta un botón identificado por cliente y teléfono; cada enlace contiene el mensaje específico de ese cliente. No se reemplaza esta UX por copiar/pegar, página intermedia, portal, token opaco de entrega o envío automático por API.

Estados permitidos:

- `PREPARADO`;
- `ENLACE_ABIERTO`, solo si técnicamente se registra la acción;
- no existe `ENVIADO` sin una confirmación externa confiable.

Mensaje posterior recomendado:

> Mensaje preparado. WhatsApp abrirá el chat con el texto listo; pulsa Enviar manualmente.

Plantillas iniciales:

- datos de acceso;
- vencimiento;
- renovación;
- cambio de contraseña;
- cambio de correo/usuario;
- cambio de perfil;
- reemplazo.

La estructura de las plantillas es configurable sin reescribir el core. La URL completa no se persiste ni se registra; el cuerpo sensible no va a logs, auditoría ni analytics y se renderiza solo bajo autorización durante el tiempo mínimo.

## 10. Cambio de contraseña

### Flujo

1. Resolver cuenta.
2. Mostrar clientes y slots activos afectados, sin revelar contraseñas en la lista.
3. Solicitar la contraseña nueva por una entrada sensible.
4. Mostrar resumen enmascarado: cuenta, cantidad de afectados y razón.
5. Confirmar.
6. Cifrar la credencial vigente y registrar el cambio entre una versión anterior y una nueva. El historial conserva metadatos de ambas versiones, no exige conservar recuperable la contraseña antigua.
7. Registrar evento crítico.
8. Generar botones WhatsApp para todos los clientes activos afectados.

El sistema no debe afirmar que esos clientes fueron notificados.

## 11. Liberación

1. Resolver la asignación que se liberará y determinar si está vencida.
2. Para Netflix y cuentas compartidas de FlujoTV, determinar si el cliente anterior podría conservar acceso.
3. Consultar la versión vigente de la credencial en la fuente de verdad. Si ya fue actualizada desde otra interfaz después del evento relevante, reutilizar ese estado y no pedir el mismo cambio otra vez.
4. Si todavía hace falta impedir el acceso anterior, solicitar/validar la contraseña nueva dentro del borrador de liberación.
5. Mostrar un único resumen crítico: cliente, cuenta/slot, credencial actualizada o ya verificada, clientes activos afectados y, si la asignación está vencida, Seguimiento automático.
6. Confirmar explícitamente.
7. En una operación atómica: actualizar la credencial cuando corresponda, cerrar la asignación, liberar el slot y, si estaba vencida, crear Seguimiento para el cliente liberado.
8. Preparar mensajes WhatsApp para todos los clientes activos afectados por el cambio de credencial.

Vencimiento por sí solo nunca dispara este flujo. Después de la liberación confirmada, el slot deja de ocupar inventario, la asignación deja de aparecer como vencida activa y el cliente queda automáticamente en Seguimiento. No se pregunta si se desea crear Seguimiento.

## 12. Incidencia Netflix/proveedor

Acciones contextuales para una cuenta caída:

- `Reemplazar todos`;
- `Reemplazar uno`;
- `Esperar por proveedor`.

Cada opción crea o modifica un borrador, muestra el resumen y exige confirmación antes de registrar la incidencia, pausar un ciclo o reemplazar. Tras confirmar, `Esperar por proveedor` abre/actualiza la incidencia, pausa el ciclo proveedor cuando corresponda y evita consumir inventario interno. Cuando llega garantía, el flujo solicita cuenta anterior, cuenta nueva, fechas, días pausados y proveedor; luego presenta otro resumen y confirma la resolución.

Los reemplazos deben generar mensajes WhatsApp por cliente afectado y conservar toda la relación histórica.

## 13. Tasa diaria

- Atajos: `/tasa`, `tasa`, `precio del día` según contexto.
- El proceso programado intenta hasta tres veces con pausas de tres segundos.
- Si obtiene tasa válida, la guarda como tasa del día y la muestra con fuente/hora.
- Si falla, notifica a ambos OWNER y ofrece `Reintentar` / `Ingresar manual`.
- Una tasa anterior no se presenta ni se usa como tasa actual. Tras tres fallos, las únicas continuaciones ofrecidas son `Reintentar` e `Ingresar manual`.

La hora aproximada aprobada es 08:30 y debe ser configurable. La zona horaria contractual es `PENDIENTE DE DECISIÓN`.

## 14. Resumen matutino

Puede incluir:

- tasa y origen;
- vencidos y por vencer;
- inventario por debajo del umbral;
- incidencias abiertas;
- cuentas esperando proveedor.

Los botones abren consultas o borradores. Ninguna acción crítica se ejecuta automáticamente desde el resumen.

`Vencidos` incluye toda asignación activa con 0 o menos días. La salida agrupa primero Netflix y después FlujoTV; dentro de cada servicio ordena desde quien lleva más tiempo vencido hasta el vencimiento más reciente. Ninguna aparece disponible hasta liberación manual.

## 15. Caja y cierre

### Caja

El flujo pregunta, según falte:

- tipo de movimiento;
- concepto/operación;
- servicio/modalidad;
- monto y moneda;
- método;
- receptor;
- Bolsa afectada, cuando corresponda.

Debe mostrar monto sugerido y permitir monto real manual. El monto real prevalece para Caja; precio/tasa aplicados quedan como referencia histórica.

### Cierre semanal

La vista inicia en la semana lunes–domingo. El bot muestra resumen por servicio, receptor, método/moneda, costos, Bolsas y resultado provisional. Cada paso aprobado del cierre se registra en el borrador; la confirmación final es manual y crítica.

El domingo no dispara ningún cierre. Este puede confirmarse domingo, lunes, martes o posteriormente. Vorkath puede avisar `Semana pendiente de cierre`, pero nunca cerrar ni mover dinero automáticamente.

## 16. Botones mínimos comunes

- `Confirmar`
- `Corregir`
- `Volver`
- `Cancelar`
- `Ver detalle`

Cada callback incluye un token opaco de sesión/borrador. No debe transportar secretos ni confiar en el texto visible. Un callback puede expirar por seguridad, pero esa expiración no cancela ni elimina la operación. Vorkath recupera el borrador vigente y genera botones contextuales nuevos.

## 17. Criterios de aceptación del canal

- Un mensaje completo llega al resumen sin preguntas redundantes.
- La búsqueda directa por teléfono y cuenta respeta sus entidades raíz.
- Las listas múltiples nunca muestran contraseñas.
- Las correcciones actualizan el borrador correcto.
- Las acciones críticas requieren confirmación vigente.
- Cancelar no aplica ninguna escritura de negocio.
- Doble confirmación produce una sola operación.
- Todo enlace WhatsApp abre directamente el chat correcto con teléfono y texto completo prellenado, usa una plantilla versionada y no marca envío.
- Dos servicios por renovar producen dos borradores, confirmaciones, pagos, movimientos y eventos independientes.
- Venta sin inventario no crea ningún registro operacional automático.
- El menú principal permanece pequeño y texto/botones modifican el mismo estado.
- `Código instalación` FlujoTV funciona por lenguaje natural y botón contextual.
- Un error técnico no imprime secretos ni identificadores internos.
- Una operación pendiente sobrevive a la expiración de callbacks hasta confirmación o cancelación explícita.
- Liberar una asignación vencida crea Seguimiento automáticamente y elimina su ocupación/vencido activo.
- Una liberación con credencial ya actualizada desde otra interfaz no solicita repetir el cambio.
- Finalizar el domingo no cierra Caja automáticamente.
