# 04 — Reglas de negocio

## 1. Convención

Cada regla posee un identificador estable. Las pruebas y decisiones futuras deben citarlo. Los estados derivados no sustituyen los hechos que los producen.

## 2. Organización y usuarios

- **BR-ORG-001:** Todo dato de negocio que pueda pertenecer a una empresa DEBE asociarse a `organization_id`.
- **BR-ORG-002:** V2 inicia con una organización y no debe exponer administración SaaS completa.
- **BR-USR-001:** Gabriel y Edward son `OWNER` con permisos equivalentes.
- **BR-USR-002:** Toda acción autenticada DEBE registrar el usuario interno; el ID de Telegram es una identidad externa vinculada, no el usuario de dominio.
- **BR-USR-003:** Un identificador de canal desconocido NO DEBE acceder a datos.

## 3. Clientes y teléfonos

- **BR-CUS-001:** Cliente y teléfono son entidades diferentes.
- **BR-CUS-002:** Un cliente PUEDE tener varios teléfonos.
- **BR-CUS-003:** Un teléfono PUEDE pertenecer a varios clientes.
- **BR-CUS-004:** El teléfono es el identificador operacional principal de búsqueda, pero no la clave primaria del cliente.
- **BR-CUS-005:** Si un teléfono resuelve varios clientes, el operador DEBE seleccionar uno antes de una acción específica.
- **BR-CUS-006:** La ubicación del cliente NO es el país de una cuenta de servicio.
- **BR-CUS-007:** Normalizar un teléfono NO debe destruir su valor original ni asignar un país sin evidencia.
- **BR-CUS-008:** Si una búsqueda normal por teléfono no encuentra clientes, Vorkath solo debe informar “no encontrado” y permitir escribir otro número o volver.
- **BR-CUS-009:** La búsqueda normal por teléfono NO debe ofrecer crear cliente. La creación solo puede ocurrir dentro del flujo explícito de Venta nueva.

## 4. Servicios, cuentas y slots

- **BR-SVC-001:** Netflix y FlujoTV son los únicos servicios del alcance funcional actual.
- **BR-SVC-002:** La arquitectura debe evitar tablas exclusivas o acoplamientos innecesarios que impidan una futura ampliación.
- **BR-SVC-003:** El alcance funcional actual se limita a Netflix y FlujoTV. No se diseña ni implementa comportamiento concreto para Disney+, Max, Prime Video u otros servicios.
- **BR-ACC-001:** Una cuenta pertenece a un servicio y una organización.
- **BR-ACC-002:** Cada cuenta guarda un identificador de acceso, una credencial cifrada, país de cuenta y estado operacional.
- **BR-ACC-003:** El país de la cuenta y la ubicación del cliente DEBEN almacenarse por separado.
- **BR-ACC-004:** Buscar por correo/usuario DEBE presentar primero la cuenta y, debajo, sus slots/perfiles, clientes asociados, disponibilidad y contexto; no debe tratarlo inicialmente como búsqueda de cliente.
- **BR-SLOT-001:** Un slot representa la unidad asignable de una cuenta: perfil comercial, perfil de emergencia o acceso exclusivo/completo.
- **BR-SLOT-002:** Un slot exclusivo NO puede tener más de una asignación activa.
- **BR-SLOT-003:** Una cuenta compartida FlujoTV PUEDE tener varios clientes mediante slots/asignaciones separados.
- **BR-SLOT-004:** Una cuenta completa FlujoTV pertenece a un solo cliente mientras su asignación esté activa.
- **BR-SLOT-005:** Un vencimiento NO libera automáticamente un slot.

## 5. Netflix

- **BR-NFX-001:** Los perfiles 1–4 son comerciales.
- **BR-NFX-002:** El perfil 5 es de emergencia.
- **BR-NFX-003:** La asignación automática DEBE priorizar: (1) cuenta activa parcialmente ocupada con slot comercial libre; (2) cuenta totalmente libre; (3) emergencia.
- **BR-NFX-004:** El perfil de emergencia solo PUEDE proponerse si no hay inventario comercial.
- **BR-NFX-005:** Usar emergencia exige advertencia y confirmación explícita.
- **BR-NFX-006:** Una cuenta esperando garantía del proveedor NO debe contarse como inventario disponible.
- **BR-NFX-007 — PENDIENTE DE DECISIÓN:** definir si Netflix cuenta completa se vende en V2 y sus reglas, precio y costo.
- **BR-NFX-008 — PENDIENTE DE DECISIÓN:** confirmar la derivación del PIN desde los últimos cuatro dígitos del teléfono.

## 6. FlujoTV

- **BR-FLW-001:** FlujoTV admite modalidad compartida y completa/exclusiva.
- **BR-FLW-002:** Una cuenta compartida puede relacionarse con varios clientes.
- **BR-FLW-003:** Una cuenta completa/exclusiva solo puede pertenecer a un cliente activo.
- **BR-FLW-004:** `PAIS_CUENTA` es obligatorio en el modelo, independiente de la ubicación del cliente.
- **BR-FLW-005:** Vorkath debe preservar la capacidad de obtener código e información de instalación mediante `codigo`, `código`, `código flujo`, `dame el código` y variantes naturales; en contexto FlujoTV PUEDE ofrecer `Código instalación`.
- **BR-FLW-006 — PENDIENTE DE DECISIÓN:** confirmar si 6 meses comprados otorgan 7 y 12 meses otorgan 14.
- **BR-FLW-007 — PENDIENTE DE DECISIÓN:** definir si el concepto actual “crédito FlujoTV” continúa y cuál es su naturaleza contable.

## 7. Vencimiento y estado

- **BR-EXP-001:** La fecha de vencimiento se almacena como hecho.
- **BR-EXP-002:** Los días restantes se calculan respecto de la fecha operacional.
- **BR-EXP-003:** Más de 2 días restantes implica `VIGENTE`.
- **BR-EXP-004:** Entre 1 y 2 días restantes implica `POR_VENCER`.
- **BR-EXP-005:** 0 o menos días implica `VENCIDO`.
- **BR-EXP-006:** `VENCIDO` describe tiempo; no describe disponibilidad.
- **BR-EXP-007:** Una asignación continúa activa hasta liberación manual o reemplazo confirmado.
- **BR-EXP-008 — PENDIENTE DE DECISIÓN:** definir la zona horaria que determina el cambio de día.
- **BR-EXP-009:** Vencidos activos DEBE agruparse primero por Netflix y luego FlujoTV; dentro de cada servicio se ordena desde el mayor tiempo vencido hasta el más reciente, incluyendo 0 y todo valor negativo.

## 8. Ventas

- **BR-SAL-001:** Una venta nueva debe generar un borrador antes de modificar datos.
- **BR-SAL-002:** Datos mínimos: servicio, modalidad, cliente/teléfono, duración, asignación, precio/monto, moneda, método y receptor del pago.
- **BR-SAL-003:** Vorkath extrae todo lo posible de un mensaje y pregunta solo lo faltante.
- **BR-SAL-004:** Precios iniciales configurables: Netflix perfil $4; FlujoTV perfil $5; FlujoTV completa $9.
- **BR-SAL-005:** El precio aplicado debe guardarse como instantánea histórica aunque la configuración cambie.
- **BR-SAL-006:** La confirmación ejecuta venta, asignación y registros financieros de forma atómica.
- **BR-SAL-007:** Si el slot dejó de estar libre, la venta no se ejecuta y el borrador debe recalcularse.
- **BR-SAL-008:** Reintentar o pulsar dos veces no puede crear ventas duplicadas.
- **BR-SAL-009:** Cuando Venta nueva no resuelve un cliente existente, puede recopilar los datos necesarios y crear cliente/teléfono dentro de la misma operación confirmada.
- **BR-SAL-010:** Si no existe inventario, Vorkath DEBE informar `No hay inventario disponible.` y solo PUEDE ofrecer revisar inventario, volver o cancelar; NO crea Seguimiento, lista de espera, cliente pendiente, reserva ni asignación ficticia.

## 8.1 Operaciones y borradores

- **BR-OPS-001:** Una operación iniciada por Gabriel o Edward permanece pendiente indefinidamente hasta `CONFIRMAR` o `CANCELAR` explícitamente.
- **BR-OPS-002:** La inactividad no cancela, elimina ni cambia automáticamente una operación pendiente.
- **BR-OPS-003:** Un callback/token de Telegram puede expirar por seguridad sin afectar la operación de negocio.
- **BR-OPS-004:** Ante un callback expirado, Vorkath debe recuperar el estado vigente y generar botones contextuales nuevos.
- **BR-OPS-005:** La permanencia de un borrador no reserva inventario indefinidamente; disponibilidad y credenciales se revalidan al confirmar.
- **BR-OPS-006:** Antes de confirmar, una corrección conversacional DEBE modificar el borrador vigente, recalcular derivados y volver a mostrar el resumen sin obligar a reiniciar.

## 9. Renovaciones

- **BR-REN-001:** La palabra “renueva” significa que el cliente ya pagó; no significa que el pago ya esté registrado en Vorkath.
- **BR-REN-002:** Una renovación puede expresarse en meses o días.
- **BR-REN-003:** Si un teléfono tiene varios servicios, Vorkath debe solicitar selección.
- **BR-REN-004:** Cada renovación corresponde exactamente a una suscripción/servicio y constituye una operación independiente.
- **BR-REN-005:** Si el cliente renueva varios servicios, Vorkath los procesa de forma secuencial: cada uno tiene borrador, confirmación, duración, pago, movimiento de Caja, auditoría y transacción propios.
- **BR-REN-006:** Deben conservarse fecha anterior, tiempo solicitado, tiempo otorgado, fecha nueva, precio y pago.
- **BR-REN-007:** Renovar no cambia la cuenta/slot salvo que se combine con un reemplazo explícito.
- **BR-REN-008 — PENDIENTE DE DECISIÓN:** definir si una suscripción vencida se extiende desde el vencimiento anterior o desde la fecha de operación.
- **BR-REN-009 — PENDIENTE DE DECISIÓN:** definir aritmética de meses al final de mes.
- **BR-REN-010 — PENDIENTE DE DECISIÓN:** definir prorrateo y redondeo de precio/costo por días.
- **BR-REN-011:** V2 NO DEBE crear `RENOVACION_MULTIPLE`, `renovar todas`, pago consolidado, rollback conjunto, una transacción única ni un movimiento de Caja único para varias renovaciones.

## 10. Pagos, operador y receptor

- **BR-PAY-001:** `OPERADOR` es quien ejecuta la acción en Vorkath.
- **BR-PAY-002:** `RECIBIDO_POR` es el titular/custodio que recibió el dinero.
- **BR-PAY-003:** Operador y receptor pueden ser personas distintas.
- **BR-PAY-004:** El operador se deriva de la sesión autenticada; no se pide si ya es inequívoco.
- **BR-PAY-005:** El receptor debe seleccionarse o extraerse; no se asume igual al operador sin una regla aprobada.
- **BR-PAY-006:** Métodos iniciales: Pago Móvil/bolívares, Zelle/USD y Binance/USDT.
- **BR-PAY-007:** Cada pago conserva monto, moneda, método, receptor, fecha y operación asociada.
- **BR-PAY-008 — PENDIENTE DE DECISIÓN:** confirmar pagos divididos entre métodos, monedas o receptores.

## 11. WhatsApp y plantillas

- **BR-WSP-001:** Vorkath DEBE generar un enlace directo `wa.me` con teléfono y texto completo prellenado; Gabriel/Edward realiza manualmente el envío final en WhatsApp.
- **BR-WSP-002:** Pulsar un enlace no equivale a envío confirmado.
- **BR-WSP-003:** Vorkath NO debe afirmar que un mensaje fue enviado sin evidencia confiable.
- **BR-WSP-004:** Plantillas iniciales configurables: acceso, vencimiento, renovación, cambio de contraseña, cambio de correo/usuario, cambio de perfil y reemplazo.
- **BR-WSP-005:** Cada mensaje generado debe referenciar la versión de plantilla usada.
- **BR-WSP-006:** El mensaje PUEDE y, cuando la atención lo requiera, DEBE incluir datos vigentes completos —correo/usuario, contraseña, perfil, PIN y demás acceso— renderizados solo para un actor autorizado y ausentes de logs técnicos.
- **BR-WSP-007:** Una acción que afecte varios clientes activos DEBE producir un botón WhatsApp por cliente/teléfono, con su mensaje específico.
- **BR-WSP-008:** La URL `wa.me` completa no se persiste ni registra; el cuerpo con credenciales no se guarda en auditoría ni analytics y se descifra/renderiza durante el tiempo mínimo.
- **BR-WSP-009:** NO se sustituye el acceso directo por copiar/pegar, página intermedia, portal de credenciales, token opaco de entrega o envío automático por API.

## 12. Cambio de contraseña

- **BR-PWD-001:** Un cambio de contraseña es crítico: borrador, resumen, confirmación y auditoría.
- **BR-PWD-002:** La contraseña recuperable se cifra de forma reversible a nivel de aplicación.
- **BR-PWD-003:** El cambio registra cuenta, actor, fecha, motivo, versión anterior, versión nueva y clientes afectados.
- **BR-PWD-004:** Después de confirmar, Vorkath genera acciones WhatsApp para todos los clientes activos afectados.
- **BR-PWD-005:** La generación de esas acciones no marca clientes como notificados.
- **BR-PWD-006:** Solo la credencial vigente debe permanecer cifrada y recuperable mientras sea necesaria operacionalmente.
- **BR-PWD-007:** El historial no exige conservar indefinidamente el valor recuperable de contraseñas antiguas; debe demostrar el cambio mediante metadatos de versión y auditoría.
- **BR-PWD-008:** Retener temporalmente una credencial antigua requiere una política explícita, limitada y aprobada.

## 13. Liberación y seguimiento

- **BR-REL-001:** Liberar perfil/cuenta es una acción crítica y manual.
- **BR-REL-002:** El vencimiento no dispara liberación.
- **BR-REL-003:** Para Netflix y cuentas compartidas de FlujoTV, si liberar requiere impedir que el cliente anterior continúe accediendo, el borrador debe demostrar que la credencial ya está actualizada o incluir el cambio requerido; ninguna actualización se aplica antes de la confirmación final.
- **BR-REL-004:** Una liberación cierra la asignación; no borra cliente, cuenta ni historia.
- **BR-FUP-001:** Un cliente puede permanecer en seguimiento indefinidamente.
- **BR-FUP-002:** Seguimiento no expira automáticamente.
- **BR-FUP-003:** Cerrar seguimiento requiere acción explícita y trazable.
- **BR-REL-005:** Si la credencial ya fue actualizada previamente desde otra interfaz sobre la misma fuente de verdad, Vorkath debe detectar la versión vigente y no solicitar el mismo cambio nuevamente.
- **BR-REL-006:** La liberación crítica sigue el orden: verificar la credencial vigente o incluir su actualización en el borrador, mostrar resumen, confirmar, ejecutar atómicamente el cambio necesario y la liberación, y preparar WhatsApp para los clientes activos afectados.
- **BR-REL-007:** Una liberación confirmada de una asignación vencida deja de ocupar inventario y deja de aparecer como vencida activa.
- **BR-FUP-004:** Liberar una asignación vencida crea Seguimiento automáticamente; no se pregunta al operador si desea crearlo.
- **BR-FUP-005:** Seguimiento puede cerrarse por acción manual posterior o dentro de un flujo confirmado de renovación/recontratación que lo contemple; nunca por el paso del tiempo.

## 14. Incidencias y proveedores

- **BR-INC-001:** Una caída de cuenta Netflix crea una incidencia vinculada a cuenta y proveedor.
- **BR-INC-002:** Opciones: `Reemplazar todos`, `Reemplazar uno` o `Esperar por proveedor`.
- **BR-INC-003:** `Esperar por proveedor` no consume inventario interno mientras la garantía esté pendiente.
- **BR-INC-004:** La incidencia permanece abierta hasta resolución explícita.
- **BR-INC-005:** Un reemplazo conserva vínculos entre cuenta anterior, cuenta nueva, clientes, fecha de caída, fecha de reemplazo, días pausados y proveedor.
- **BR-INC-006:** Nunca se destruye el historial de la cuenta anterior.
- **BR-INC-007:** El ciclo del proveedor puede pausarse durante espera de garantía y reanudarse al recibir reemplazo.
- **BR-INC-008:** Una sustitución de asignación y la preparación de sus comunicaciones se coordinan como parte de la misma operación de dominio. La sustitución se ejecuta atómicamente; después de confirmarla, Vorkath genera las acciones WhatsApp correspondientes. El envío final continúa siendo manual.

## 15. Inventario

- **BR-INV-001:** Disponibilidad depende de estado de cuenta, estado del slot y ausencia de asignación activa; no del vencimiento de un cliente.
- **BR-INV-002:** Netflix muestra perfiles comerciales libres, cuentas totalmente libres, perfiles de emergencia y cuentas esperando proveedor.
- **BR-INV-003:** FlujoTV muestra perfiles libres y cuentas completas libres.
- **BR-INV-004:** Los umbrales de inventario bajo son configurables por servicio/modalidad.
- **BR-INV-005:** Un slot no puede reservarse o asignarse simultáneamente a dos operaciones.
- **BR-INV-006:** La compra/adquisición de cuentas al proveedor se registra para inventario y trazabilidad.
- **BR-INV-007:** La ausencia de inventario no crea automáticamente seguimiento, espera, cliente pendiente, reserva ni otra entidad de negocio.

## 16. Tasa y automatizaciones

- **BR-RATE-001:** La tasa diaria se consulta una vez por la mañana, aproximadamente a las 08:30, en horario configurable.
- **BR-RATE-002:** Se realizan hasta tres intentos separados por tres segundos.
- **BR-RATE-003:** Si todos fallan, se notifica a Gabriel y Edward y se ofrecen reintento y entrada manual.
- **BR-RATE-004:** La tasa obtenida se conserva para el día operacional.
- **BR-RATE-005:** La tasa anterior nunca se presenta silenciosamente como actual.
- **BR-RATE-006:** Una tasa manual identifica actor, fecha/hora y motivo/fuente.
- **BR-RATE-007:** Tras tres fallos, Vorkath solo notifica a Gabriel y Edward y ofrece `Reintentar` o `Ingresar tasa manual`; no usa la tasa anterior como fallback actual.
- **BR-AUTO-001:** El resumen matutino puede enviar información no crítica.
- **BR-AUTO-002:** Ninguna acción crítica se ejecuta automáticamente.

## 17. Caja, Bolsas y cierre

Las reglas detalladas están en `07-FINANCIAL-RULES.md`.

- **BR-FIN-001:** Caja registra dinero recibido por operaciones.
- **BR-FIN-002:** Bolsa representa capital acumulado del negocio y no se reinicia semanalmente.
- **BR-FIN-003:** Caja y Bolsa no son la misma entidad ni el mismo saldo.
- **BR-FIN-004:** La semana operacional es lunes–domingo.
- **BR-FIN-005:** El cierre es manual, revisable y auditable.
- **BR-FIN-006:** Primero se aseguran costos operativos; luego se calcula beneficio.
- **BR-FIN-007:** El beneficio restante se divide 50% Gabriel / 50% Edward, configurable.
- **BR-FIN-008:** No se debe descontar dos veces la compra de cuentas si el costo ya se reconoce por venta.
- **BR-FIN-009:** Terminar el domingo NO cierra Caja; el cierre solo ocurre tras revisión y confirmación explícita, sea domingo o posteriormente.
- **BR-FIN-010:** El costo operativo variable semanal se reconoce por las unidades efectivamente vendidas según política versionada.
- **BR-FIN-011:** Publicidad, fee Zelle y ChatGPT son políticas editables con monto, frecuencia y estado activo/inactivo; la política vigente distribuye los costos mensuales entre cuatro semanas.
- **BR-FIN-012:** Toda salida de Bolsa registra concepto, monto, moneda, Bolsa origen, operador y fecha.

## 18. Auditoría y correcciones

- **BR-AUD-001:** Se auditan revelaciones de credenciales, cambios, reemplazos, liberaciones, operaciones financieras y cierres.
- **BR-AUD-002:** Una operación confirmada es inmutable como hecho histórico.
- **BR-AUD-003:** Una corrección posterior crea un ajuste enlazado y no sobrescribe silenciosamente.
- **BR-AUD-004:** Todo evento crítico identifica actor, organización, canal, entidad, antes/después protegido, hora y resultado.
- **BR-AUD-005:** La auditoría no debe contener secretos en texto claro.
- **BR-AUD-006:** Demostrar una rotación de credencial no requiere almacenar la contraseña antigua; bastan referencias de versión, actor, fecha, motivo, cuenta y clientes afectados.
- **BR-AUD-007:** Venta, renovación, liberación, cambios de contraseña/correo/perfil, reemplazo, cuenta caída, garantía, pago, conversión Bs→USDT, costo, cierre y corrección de operación requieren confirmación y trazabilidad; las lecturas no críticas no.

## 19. Conversación y navegación

- **BR-UX-001:** Vorkath pregunta solamente lo que falta y no vuelve a pedir campos ya extraídos o resueltos inequívocamente.
- **BR-UX-002:** La interfaz combina un menú principal pequeño, botones contextuales y lenguaje natural; botón y texto modifican el mismo estado de operación.
- **BR-UX-003:** Los botones permanentes no deben crecer hasta representar todo el dominio; las acciones se muestran según cliente, cuenta o servicio actual.

## 20. Pendientes bloqueantes

No deben implementarse cálculos finales de los puntos siguientes hasta decidir:

- Netflix cuenta completa: `BR-NFX-007`.
- PIN Netflix: `BR-NFX-008`.
- promoción FlujoTV: `BR-FLW-006`.
- crédito FlujoTV: `BR-FLW-007`.
- zona horaria: `BR-EXP-008`.
- fecha base y fin de mes: `BR-REN-008` y `BR-REN-009`.
- prorrateo diario: `BR-REN-010`.
- pagos divididos: `BR-PAY-008`.
