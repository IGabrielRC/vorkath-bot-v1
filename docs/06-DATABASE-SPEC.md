# 06 — Especificación lógica de base de datos

## 1. Propósito y límites

Este documento define el esquema lógico objetivo de PostgreSQL. No contiene DDL ni autoriza crear tablas, desplegar servidores o importar datos productivos.

La base debe representar el dominio de `05-DOMAIN-MODEL.md`; no debe reproducir hojas, columnas o `row_number` como arquitectura.

## 2. Convenciones

- Claves primarias: UUID generado por la aplicación/base.
- Fechas de evento: `timestamptz` en UTC.
- Fechas comerciales de vencimiento: `date`, interpretadas mediante zona horaria operacional.
- Dinero: `numeric`, nunca punto flotante.
- Moneda: código estable (`VES`, `USD`, `USDT`) en catálogo/configuración.
- Campos flexibles: `jsonb` solo para metadatos o borradores; no para ocultar relaciones centrales.
- Todos los registros mutables incluyen `created_at`, `updated_at` y, cuando aplique, `archived_at`.
- Datos de negocio multi-tenant incluyen `organization_id` y restricciones compuestas por organización.
- Los secretos cifrados se separan de datos consultables.
- Los hechos financieros y de auditoría son append-only.

## 3. Catálogos y tipos controlados

No es obligatorio implementar todos como enum PostgreSQL; pueden ser tablas de catálogo cuando deban ampliarse.

| Concepto | Valores iniciales |
|---|---|
| Usuario | `ACTIVE`, `DISABLED` |
| Rol | `OWNER` |
| Cuenta | `ACTIVE`, `INACTIVE`, `WAITING_SUPPLIER`, `FALLEN`, `RETIRED` |
| Slot | `AVAILABLE`, `RESERVED`, `ASSIGNED`, `BLOCKED`, `RETIRED` |
| Categoría slot | `COMMERCIAL`, `EMERGENCY`, `FULL_EXCLUSIVE` |
| Asignación | `ACTIVE`, `RELEASED`, `REPLACED`, `CANCELLED` |
| Operación | `DRAFT`, `CONFIRMED`, `FAILED`, `CANCELLED`, `ADJUSTED` |
| Incidencia | `OPEN`, `WAITING_SUPPLIER`, `PARTIALLY_RESOLVED`, `RESOLVED`, `CANCELLED` |
| Movimiento | `INFLOW`, `OUTFLOW`, `TRANSFER`, `ADJUSTMENT` |
| Preparación WhatsApp | `PREPARED`, `LINK_OPENED`, `EXPIRED` |
| Cierre | `DRAFT`, `CONFIRMED`, `ADJUSTED` |

`VIGENTE`, `POR_VENCER` y `VENCIDO` no deben ser el estado persistido del slot. Son una proyección derivada.

## 4. Organización y acceso

### `organizations`

| Campo | Tipo lógico | Regla |
|---|---|---|
| `id` | uuid | PK. |
| `name` | text | Requerido. |
| `status` | text/catalog | Activa/inactiva. |
| `operational_timezone` | text | IANA; decisión pendiente inicial. |
| `settings_version` | integer | Control de configuración. |

### `users`

Campos: `id`, `organization_id`, `display_name`, `status`, `created_at`, `updated_at`.

Restricciones:

- nombre requerido dentro de organización;
- desactivar no borra historia.

### `roles`, `user_roles`

El alcance inicial contiene `OWNER`. `user_roles` une usuario, rol, organización y vigencia. No implementar permisos granulares hasta necesitarlos, pero evitar comprobaciones por nombre literal.

### `external_identities`

Campos: `id`, `organization_id`, `user_id`, `provider` (`TELEGRAM`, `WEB`), `external_subject`, `verified_at`, `status`.

Restricción única: `(organization_id, provider, external_subject)`.

## 5. Clientes y teléfonos

### `customers`

Campos:

- `id`, `organization_id`;
- `display_name`;
- `location_text`;
- `location_raw` nullable (texto literal indicado);
- `location_display` nullable (forma limpia para mostrar);
- `location_city` nullable (solo cuando se afirma, nunca inferida);
- `location_state_region` nullable (solo cuando se afirma);
- `location_country` nullable (solo cuando se afirma; `Caracas` sola nunca implica país);
- `notes`;
- `status`;
- timestamps.

No guardar un único teléfono obligatorio en esta tabla. `location_*` es `CUSTOMER_LOCATION`: independiente de `account_country` (`PAIS_CUENTA`) en ambas direcciones —ninguna deriva ni sobrescribe a la otra.

### `phones`

Campos:

- `id`, `organization_id`;
- `raw_value`;
- `normalized_e164` nullable;
- `digits_only`;
- `country_code` nullable;
- `normalization_status`.

Índices:

- `(organization_id, normalized_e164)`;
- `(organization_id, digits_only)`.

No forzar unicidad global: un mismo número puede aparecer con evidencia incompleta; la deduplicación es parte de importación. Si se confirma identidad canónica, la unicidad puede aplicarse por organización.

### `customer_phones`

Campos: `id`, `organization_id`, `customer_id`, `phone_id`, `label`, `is_primary`, `valid_from`, `valid_to`, timestamps.

Restricción única parcial/lógica para evitar duplicar la misma relación activa.

### `follow_ups`

Campos: `id`, `organization_id`, `customer_id`, `subscription_id` nullable, `incident_id` nullable, `status`, `reason`, `opened_by`, `opened_at`, `closed_by` nullable, `closed_at` nullable, `notes`.

No existe expiración automática.

## 6. Servicios, planes y configuración comercial

### `services`

Campos: `id`, `organization_id`, `code`, `name`, `status`, `capabilities` (`jsonb` limitado), timestamps.

Unicidad: `(organization_id, code)`.

El catálogo funcional inicial contiene únicamente Netflix y FlujoTV. Su forma técnica puede admitir crecimiento posterior, pero esta especificación no define otros servicios.

### `service_plans`

Campos: `id`, `organization_id`, `service_id`, `code`, `name`, `modality`, `billing_unit`, `status`.

### `price_policies`

Campos:

- `id`, `organization_id`, `service_plan_id`;
- `amount`, `currency`;
- `valid_from`, `valid_to`;
- `created_by`, `reason`;
- `version`.

No actualizar un precio histórico: cerrar vigencia y crear versión.

Valores iniciales aprobados:

- Netflix perfil: 4 USD;
- FlujoTV perfil: 5 USD;
- FlujoTV completa: 9 USD.

### `operational_cost_policies`

Campos equivalentes a política de precio, más `recognition_unit`. Valores iniciales:

- Netflix perfil: 2 USD por unidad vendida;
- FlujoTV perfil: 1.50 USD;
- FlujoTV completa: 3.50 USD.

### `inventory_thresholds`

Campos: `id`, `organization_id`, `service_id`, `plan_id` nullable, `slot_category`, `minimum_available`, `enabled`, vigencia.

## 7. Proveedores, cuentas y credenciales

### `suppliers`

Campos: `id`, `organization_id`, `name`, `status`, `contact_metadata` protegido, timestamps.

### `service_accounts`

Campos:

- `id`, `organization_id`, `service_id`;
- `login_identifier_normalized`, `login_identifier_display`;
- `account_country`;
- `supplier_id` nullable;
- `status`;
- `acquired_at`, `retired_at` nullable;
- `metadata` limitado;
- timestamps.

Índices:

- búsqueda exacta case-insensitive por identificador dentro de servicio/organización;
- `(organization_id, service_id, status)`;
- `(organization_id, supplier_id, status)`.

El login puede ser sensible; definir protección adicional según evaluación de seguridad.

La consulta por `login_identifier_normalized` devuelve como raíz la cuenta y carga debajo sus slots, suscripciones/clientes y disponibilidad; no se resuelve inicialmente como cliente.

### `credential_versions`

Campos:

- `id`, `organization_id`, `service_account_id`;
- `secret_ciphertext` nullable para versiones no vigentes;
- `encryption_key_version` nullable cuando no se conserva ciphertext;
- `nonce_iv` y `auth_tag` nullable según el esquema elegido;
- `status` (`CURRENT`, `SUPERSEDED`);
- `created_by`, `created_at`, `superseded_at`;
- `change_reason`;
- `supersedes_id` nullable.

Restricción: una sola credencial `CURRENT` por cuenta/ámbito, con secreto cifrado y recuperable. Una versión `SUPERSEDED` conserva identidad y metadatos, pero no requiere conservar el valor recuperable. No guardar secretos “antes/después” en auditoría.

### `credential_changes`

Campos:

- `id`, `organization_id`, `service_account_id`;
- `previous_version_id`, `new_version_id`;
- `actor_user_id`, `changed_at`, `reason`;
- `source_channel`, `operation_id`;
- `affected_customers_count`;
- timestamps.

### `credential_change_affected_subscriptions`

Relaciona el cambio con las suscripciones/clientes activos afectados. Permite generar comunicaciones y demostrar el alcance sin almacenar contraseñas anteriores.

Una política futura puede retener temporalmente el ciphertext anterior con `retain_until`; esa excepción debe ser explícita, limitada y no existe por defecto.

### `supplier_cycles`

Campos: `id`, `organization_id`, `service_account_id`, `supplier_id`, `starts_on`, `ends_on`, `status`, `created_at`.

### `supplier_cycle_pauses`

Campos: `id`, `organization_id`, `supplier_cycle_id`, `incident_id`, `paused_at`, `resumed_at` nullable, `paused_days` derivado/confirmado, `reason`.

## 8. Slots e inventario

### `account_slots`

Campos:

- `id`, `organization_id`, `service_account_id`;
- `slot_code`, `display_label`;
- `category`;
- `capacity` (inicialmente 1 para exclusividad);
- `status`;
- `allocation_priority`;
- `is_assignable`;
- timestamps.

Restricciones:

- unicidad `(service_account_id, slot_code)`;
- perfiles Netflix 1–4 categoría `COMMERCIAL`, perfil 5 `EMERGENCY`;
- reglas incompatibles entre cuenta completa y perfiles deben aplicarse al confirmar.

### `inventory_acquisitions`

Campos: `id`, `organization_id`, `supplier_id`, `service_id`, `account_id` nullable, `quantity`, `unit`, `amount_paid` nullable, `currency` nullable, `acquired_at`, `operator_id`, `notes`.

Registrar compra no implica automáticamente gasto semanal; el tratamiento está en reglas financieras.

### Vista/proyección `inventory_availability`

Deriva disponibilidad considerando:

- cuenta activa y no caída/esperando proveedor;
- slot asignable y no bloqueado;
- ausencia de asignación activa o reserva vigente;
- categoría comercial/emergencia;
- modalidad.

No usa `expires_on` como liberación.

Para Netflix, la selección ordena: cuenta parcialmente ocupada con perfil comercial libre, cuenta totalmente libre y finalmente perfil 5 de emergencia. Emergencia solo se propone cuando no queda inventario comercial y nunca se confirma sin autorización explícita.

## 9. Suscripciones y operaciones

### `subscriptions`

Campos:

- `id`, `organization_id`, `customer_id`, `service_plan_id`, `account_slot_id`;
- `status` de ocupación;
- `starts_on`, `expires_on`;
- `released_at`, `release_reason` nullable;
- `release_operation_id` nullable;
- `replaced_by_subscription_id` nullable;
- timestamps.

Restricciones:

- una asignación activa por slot exclusivo;
- cliente, plan, cuenta/slot y organización coherentes;
- `expires_on` no cambia `status` automáticamente.

Liberar una asignación vencida debe cambiarla a `RELEASED`, liberar el slot, excluirla de vencidos activos y crear un `follow_up` abierto dentro de la misma operación. Para Netflix y cuentas compartidas FlujoTV, la transacción también verifica la versión vigente de la credencial y la actualiza solo si todavía es necesario impedir el acceso anterior.

La falta de inventario en Venta nueva no inserta `customer`, `phone`, `follow_up`, `subscription`, reserva ni lista de espera.

### `sale_operations`

Campos:

- `id`, `organization_id`;
- `operation_type` (`NEW_SALE`, `RENEWAL`, `RELEASE`, `REPLACEMENT`, `CORRECTION`);
- `status`;
- `operator_id`;
- `channel`, `channel_reference`;
- `idempotency_key`;
- `original_operation_id` nullable;
- `reason` nullable;
- `confirmed_at`, timestamps.

Unicidad: `(organization_id, idempotency_key)`.

No existe tipo `MULTI_RENEWAL` ni `RENOVACION_MULTIPLE`. Cada fila `RENEWAL` corresponde a una sola suscripción/servicio; solicitar otra crea otra operación independiente.

### `operation_items`

Campos:

- `id`, `organization_id`, `sale_operation_id`, `subscription_id`;
- `service_plan_id`, `account_slot_id`;
- `requested_months`, `requested_days`;
- `granted_months`, `granted_days`;
- `previous_expires_on`, `new_expires_on`;
- `unit_price`, `price_currency`, `subtotal`;
- `cost_policy_id`, `recognized_operational_cost`;
- `metadata` limitado.

La diferencia entre tiempo solicitado y otorgado permite representar promociones solo si se aprueban.

Restricción de dominio: una operación `RENEWAL` tiene exactamente un `operation_item`. No se consolida su pago, Caja, auditoría o transacción con la renovación de otra suscripción.

### `draft_operations`

Campos: `id`, `organization_id`, `user_id`, `session_id`, `operation_type`, `state`, `payload_json`, `version`, `last_validated_at`, `confirmed_at` nullable, `cancelled_at` nullable, timestamps.

El payload no debe contener credenciales en texto claro. Confirmar usa control optimista de `version`. No existe expiración automática: el estado permanece `DRAFT` hasta confirmación o cancelación explícita. La revalidación al confirmar evita que su permanencia reserve inventario o reutilice una credencial obsoleta.

## 10. Pagos, Caja y Bolsas

### `payment_methods`

Catálogo configurable: Pago Móvil, Zelle, Binance y futuros.

### `cash_holders`

Campos: `id`, `organization_id`, `name`, `linked_user_id` nullable, `status`.

### `payments`

Campos:

- `id`, `organization_id`, `sale_operation_id`;
- `amount`, `currency`, `payment_method_id`;
- `received_by_holder_id`;
- `received_at`;
- `exchange_rate_id` nullable;
- `equivalent_usd` nullable;
- `status`, `reference` nullable;
- `created_by`.

Aunque el esquema admite varios pagos por operación, la UX de pago dividido está pendiente.

### `business_wallets`

Campos: `id`, `organization_id`, `code`, `name`, `currency`, `status`. Iniciales: Bolsa Zelle (USD), Bolsa Binance (USDT).

### `cash_movements`

Campos:

- `id`, `organization_id`, `movement_type`;
- `amount`, `currency`;
- `payment_id` nullable;
- `wallet_id` nullable;
- `cash_holder_id` nullable;
- `counterparty_wallet_id` nullable;
- `source_event_type`, `source_event_id`;
- `operator_id`, `occurred_at`;
- `reverses_movement_id` nullable;
- `description`.

Restricciones:

- cantidad positiva; la dirección la determina el tipo;
- una fuente genera cada movimiento una sola vez;
- transferencias deben tener lados correlacionados;
- no se edita un movimiento confirmado; se revierte/ajusta.

### `recurring_cost_policies`

Campos: `id`, `organization_id`, `concept`, `amount`, `currency`, `frequency`, `weekly_allocation_method`, vigencia, estado.

Iniciales:

- publicidad: 20 USD semanal;
- Zelle: 5 USD mensual;
- ChatGPT: 20 USD mensual;
- mensual distribuido entre 4 semanas mientras esa política esté vigente.

### `expense_payments`

Campos: `id`, `organization_id`, `concept`, `amount`, `currency`, `wallet_id`, `operator_id`, `paid_at`, `cash_movement_id`, `evidence_reference` nullable.

### `exchange_rates`

Campos: `id`, `organization_id`, `rate_date`, `base_currency`, `quote_currency`, `rate`, `source`, `retrieval_mode`, `retrieved_at`, `entered_by` nullable, `status`, `attempt_metadata`.

Restricción recomendada: solo una tasa `CURRENT` por organización/par/fecha; reemplazos conservan historia.

### `weekly_closures`

Campos:

- `id`, `organization_id`, `week_start`, `week_end`;
- `status`, `version`;
- totales por referencia a un snapshot protegido;
- `cost_policy_snapshot`;
- `profit_split_snapshot`;
- `prepared_by`, `confirmed_by`, `confirmed_at`;
- `adjusts_closure_id` nullable;
- `notes`.

Restricción: una versión confirmada principal por semana; ajustes posteriores enlazados.

Ningún job crea o confirma un cierre por llegar el domingo. El estado solo pasa de `DRAFT` a `CONFIRMED` tras revisión y confirmación explícita.

## 11. Incidencias y reemplazos

### `supplier_incidents`

Campos: `id`, `organization_id`, `service_account_id`, `supplier_id`, `incident_type`, `status`, `fell_at`, `decision`, `opened_by`, `opened_at`, `resolved_at` nullable, `notes`.

### `incident_affected_subscriptions`

Campos: `id`, `organization_id`, `incident_id`, `subscription_id`, `resolution_strategy`, `resolved_at`, `replacement_id` nullable.

### `account_replacements`

Campos: `id`, `organization_id`, `incident_id`, `old_account_id`, `new_account_id`, `replaced_at`, `paused_days`, `supplier_id`, `operator_id`, `operation_id`, `notes`.

No usar borrado en cascada que elimine historia de cuenta/suscripción.

## 12. Comunicación y conversación

### `message_templates`

Campos: `id`, `organization_id`, `template_type`, `service_id` nullable, `locale`, `version`, `body`, `status`, `valid_from`, `created_by`.

Tipos iniciales: acceso, vencimiento, renovación, cambio de contraseña, cambio de correo/usuario, cambio de perfil y reemplazo. La estructura se modifica mediante versiones/configuración, no reescribiendo reglas de negocio.

### `prepared_messages`

Campos: `id`, `organization_id`, `customer_id`, `phone_id`, `template_id`, `template_version`, `purpose`, `render_variables_protected` nullable, `encrypted_rendered_body` nullable, `status`, `prepared_by`, `prepared_at`, `link_opened_at` nullable, `expires_at`.

El backend genera al solicitarlo un `wa.me` con teléfono y texto completo prellenado, incluidos los datos de acceso vigentes cuando corresponda. No persiste ni registra la URL completa. Para varios clientes afectados existe una preparación por cliente/teléfono y cada cuerpo usa sus datos correctos.

La retención y necesidad de guardar el cuerpo renderizado son pendientes. Preferir variables no secretas y renderizar bajo autorización cuando sea suficiente. Si el cuerpo sensible se almacena temporalmente, se cifra y queda sujeto a política limitada. `expires_at` puede invalidar la preparación/enlace y permitir regenerarlo; nunca cancela la operación de negocio.

### `installation_info_versions`

Campos: `id`, `organization_id`, `service_id`, `platform`, `version_label`, `code_or_url_encrypted_or_protected`, `source`, `retrieved_at`, `status`.

### `conversation_sessions`

Campos: `id`, `organization_id`, `user_id`, `provider`, `external_chat_id`, `status`, `active_draft_id` nullable, `last_activity_at`, timestamps.

Una sesión técnica puede reabrirse/recrearse, pero debe recuperar `active_draft_id`; la inactividad nunca elimina el borrador.

### `conversation_contexts`

Campos: `id`, `organization_id`, `session_id`, `draft_operation_id` nullable, `context_type`, `context_version`, `options_json`, `created_at`, `valid_until` nullable.

Las opciones JSON solo guardan identificadores opacos y etiquetas no sensibles; no credenciales. `valid_until` controla botones/tokens, no la operación. Si el contexto expira, el backend carga el borrador y genera una versión nueva.

## 13. Auditoría

### `audit_events`

Campos:

- `id`, `organization_id`;
- `event_type`, `severity`;
- `actor_user_id` nullable, `external_identity_id` nullable;
- `entity_type`, `entity_id`;
- `operation_id` nullable;
- `channel`, `request_correlation_id`;
- `result`;
- `metadata_redacted`;
- `occurred_at`;
- integridad/encadenamiento opcional.

Índices: organización+fecha, actor+fecha, entidad+fecha, tipo+fecha, correlación.

Nunca incluir contraseña, token, URL `wa.me` completa, URL firmada ni cuerpo sensible completo.

## 14. Restricciones e índices críticos

1. Índices por `organization_id` en todas las rutas frecuentes.
2. Búsqueda canónica de teléfono y cuenta.
3. Unicidad de idempotencia por organización.
4. Restricción de una asignación activa por slot exclusivo.
5. Restricción de una credencial vigente por cuenta.
6. Índices de vencimiento sobre asignaciones activas.
7. Índices de incidencia por estado/proveedor.
8. Índices financieros por semana, receptor, método, moneda y fuente.
9. Claves foráneas compuestas/lógica de servicio que impidan cruces entre organizaciones.
10. Borrado restrictivo en hechos históricos; archivado lógico para catálogos.
11. Ningún proceso de limpieza elimina `draft_operations` pendientes por antigüedad.
12. Restricción/validación que impide más de un item en una operación `RENEWAL`.
13. Ningún job confirma `weekly_closures` automáticamente.

## 15. Transacciones e idempotencia

### Venta/renovación individual

Una confirmación debe cubrir en la misma unidad:

- operación y su item (en renovación, exactamente uno);
- creación/actualización de suscripción;
- transición de slot;
- pago;
- movimientos derivados;
- auditoría de resultado.

En renovación, esa unidad contiene una sola suscripción/servicio. Otra renovación usa otra clave de idempotencia, operación, pago, movimientos y transacción; el fallo de una no revierte otra ya confirmada.

### Cambio de contraseña

- bloquear cuenta;
- crear versión nueva;
- marcar la anterior como sustituida y retirar su secreto recuperable salvo política temporal explícita;
- registrar `credential_change`, afectados, evento y mensajes preparados;
- confirmar todo o revertir todo.

### Liberación de asignación vencida

- bloquear/revalidar asignación, slot y cuenta;
- comprobar si la credencial vigente ya fue actualizada desde otro canal;
- actualizarla solo cuando aún sea necesario;
- cerrar la asignación y liberar el slot;
- crear Seguimiento automáticamente;
- preparar mensajes para clientes activos afectados;
- confirmar todo o revertir todo.

### Cierre

El snapshot debe calcularse desde movimientos confirmados y guardar las versiones de políticas usadas. La confirmación usa bloqueo/versión para evitar cierres concurrentes.

## 16. Seguridad a nivel de datos

- Credenciales cifradas con cifrado autenticado y llaves fuera de PostgreSQL.
- Separar capacidad de consultar metadatos de capacidad de descifrar.
- Backups cifrados.
- Usuario de aplicación sin privilegios de administración.
- Usuario de migración temporal y revocable.
- Conexión privada/TLS según topología del VPS.
- RLS puede añadirse como defensa adicional; no sustituye filtros obligatorios por organización.

## 17. Proyecciones recomendadas

Sin ser fuentes de verdad:

- inventario disponible por servicio/modalidad;
- vencidos/por vencer agrupados Netflix y luego FlujoTV, ordenados dentro de cada servicio del mayor tiempo vencido al más reciente e incluyendo 0 y negativos;
- ficha de cliente por teléfono;
- cuenta y ocupación;
- Caja semanal;
- saldos por Bolsa;
- incidencias abiertas;
- resumen matutino.

Las proyecciones deben poder reconstruirse desde hechos y relaciones.

Una consulta por teléfono sin coincidencias devuelve un resultado vacío. No debe crear `customer`, `phone` ni `customer_phone`; esas altas solo pertenecen a una Venta nueva confirmada.

## 18. Datos que no deben migrarse 1:1

- `row_number` como identidad;
- columnas temporales de `LOGS_CHAT` y `LOGS_CAJA`;
- listas serializadas dentro de `CORREO` u otros campos reutilizados;
- acumuladores semanales como verdad financiera;
- etiquetas libres de estado sin mapeo;
- contraseñas en columnas abiertas;
- valores `No encontrado` como datos reales;
- filas vacías usadas como inventario.

## 19. Pendientes que afectan el esquema

- Zona horaria operacional.
- Retención de auditoría, logs y mensajes preparados. Los borradores pendientes quedan excluidos de cualquier eliminación por tiempo.
- Necesidad comercial de Netflix completa.
- Naturaleza de crédito FlujoTV.
- Pago dividido en UX, aunque el esquema lo soporte.
- Catálogo final de estados importados y reglas de deduplicación tras perfilar datos reales.
