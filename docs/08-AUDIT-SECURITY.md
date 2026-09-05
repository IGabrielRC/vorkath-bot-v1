# 08 — Auditoría y seguridad

## 1. Objetivo

Vorkath V2 almacenará credenciales recuperables de servicios, datos de clientes y movimientos financieros. La seguridad debe ser sencilla de operar para un equipo de dos personas, con controles automáticos y componentes gratuitos/autoalojados.

Este documento define requisitos; no autoriza despliegues ni acceso a producción.

## 2. Activos sensibles

| Activo | Riesgo principal | Protección mínima |
|---|---|---|
| Tokens de Telegram/API | Control del bot | Secret manager/variables protegidas, rotación. |
| Contraseñas Netflix/FlujoTV | Acceso a cuentas de clientes | Cifrado reversible autenticado a nivel de aplicación. |
| Contraseñas de usuarios Vorkath | Toma de cuenta interna | Hashing resistente, nunca cifrado reversible. |
| Teléfonos y nombres | Privacidad | Acceso por rol, logs reducidos, backups cifrados. |
| Caja/Bolsas | Fraude o pérdida de trazabilidad | Libro inmutable, confirmación, auditoría. |
| Backups | Exposición total/pérdida | Cifrado, acceso restringido, restauración probada. |
| Workflows/exportaciones | Secretos incrustados | Manejo temporal sensible, redacción y eliminación controlada. |

## 3. Modelo de confianza

- Gabriel y Edward son OWNER equivalentes.
- Telegram autentica el canal, pero Vorkath debe vincular el ID externo con un usuario interno activo.
- El panel web, desarrollado por separado, tendrá su propio mecanismo de autenticación y sesión. Esta especificación solo exige que consuma la autorización y el dominio compartidos sin duplicar reglas.
- La base de datos no debe exponerse públicamente.
- Solo el backend descifra credenciales; Telegram, panel y jobs no reciben llaves maestras.
- n8n/Sheets productivos permanecen separados durante desarrollo.

## 4. Control de acceso

### 4.1 Autenticación

- Validar el origen de cada update/callback de Telegram según el mecanismo de integración.
- Asociar `external_subject` con usuario activo.
- Rechazar identificadores no reconocidos con respuesta neutra.
- Para la integración futura del panel web, su equipo deberá usar sesiones seguras, expiración, protección CSRF cuando aplique y segundo factor si se aprueba. Construir ese frontend/autenticación queda fuera del alcance actual.
- Las contraseñas propias se almacenan con un algoritmo moderno de hashing con sal única y parámetros actualizables.

### 4.2 Autorización

- Verificar organización y permiso en el backend para cada comando.
- Separar permisos de consultar metadatos, revelar credenciales y ejecutar acciones críticas.
- Aunque ambos OWNER puedan todo inicialmente, no omitir las comprobaciones.
- El acceso directo a PostgreSQL no sustituye autorización de aplicación.

### 4.3 Sesiones y callbacks

- Tokens de callback opacos, de corta vida, asociados a sesión, usuario, organización y versión de borrador.
- Rechazar callback reutilizado, expirado o de otro chat.
- No incluir secretos, IDs predecibles ni datos financieros completos en `callback_data`.
- Rechazar un callback no cancela ni elimina el borrador. El backend recupera la operación pendiente y emite botones vigentes nuevos.

## 5. Gestión de secretos

- Tokens, claves maestras, contraseñas de infraestructura y credenciales de fuentes externas se proporcionan mediante secretos/variables de entorno protegidas.
- No guardar secretos en repositorio, documentación, Docker image, historial del shell o mensajes de error.
- Separar secretos de desarrollo y producción.
- Rotar un secreto ante sospecha, exposición o salida de un integrante.
- Mantener un inventario mínimo: nombre, propósito, propietario, fecha de rotación; nunca el valor.
- Los JSON exportados se consideran sensibles y no deben subirse al repositorio.

## 6. Cifrado de credenciales de servicio

Las contraseñas de Netflix/FlujoTV deben recuperarse para el cliente, por lo que un hash no sirve.

Requisitos:

- cifrado autenticado a nivel de aplicación;
- nonce/IV único por versión;
- versión de llave guardada junto al ciphertext;
- llave maestra fuera de PostgreSQL y de los backups de base;
- posibilidad de rotación y recifrado controlado;
- descifrado solo en memoria y durante el tiempo mínimo;
- redacción automática en logs, trazas y errores;
- auditoría de cada revelación y cambio.

Solo la contraseña vigente debe permanecer cifrada y recuperable mientras sea necesaria. El historial de cambio conserva cuenta, actor, fecha, motivo, identificadores de versión anterior/nueva y clientes afectados, pero no exige conservar el valor recuperable anterior.

La auditoría guarda referencias, motivo y resultado, nunca secreto anterior/nuevo en claro. Una retención temporal de la credencial anterior solo puede existir mediante política explícita, limitada y aprobada.

### 6.1 WhatsApp directo con datos vigentes

La protección de secretos no elimina la UX contractual. Para un OWNER autorizado, Vorkath genera directamente un `wa.me` con teléfono y mensaje completo prellenado; el texto puede incluir correo/usuario, contraseña vigente, perfil, PIN y demás datos necesarios. No se introduce página intermedia, portal ni token opaco de entrega.

Controles obligatorios:

- generar un enlace específico por cliente afectado;
- descifrar/renderizar solo durante el tiempo mínimo;
- no persistir ni registrar la URL completa;
- no guardar el cuerpo con credenciales en auditoría ni analytics;
- redactar URL, cuerpo y credenciales en logs, errores y trazas;
- no afirmar que el mensaje fue enviado: Gabriel/Edward lo envía manualmente en WhatsApp.

## 7. Seguridad de PostgreSQL y red

- PostgreSQL debe escuchar solo en red privada/local necesaria para la aplicación.
- No publicar el puerto de base de datos a Internet.
- Usuario de aplicación con permisos mínimos sobre su esquema.
- Usuario separado para migraciones, deshabilitado o no usado en ejecución normal.
- Credenciales distintas entre entornos.
- Conexión cifrada cuando atraviese una red no confiable.
- Actualizaciones de seguridad planificadas del host, runtime, PostgreSQL y dependencias.
- Firewall con solo servicios requeridos.
- El panel y webhook deben estar detrás de HTTPS.
- No compartir el mismo secreto entre bot, panel, backup y base.

## 8. Aislamiento por organización

- Todas las consultas de negocio incluyen `organization_id`.
- Relaciones validan que ambos lados pertenezcan a la misma organización.
- Pruebas negativas intentan leer/modificar datos de otra organización.
- RLS es una defensa adicional recomendable, no reemplaza autorización de aplicación.
- Jobs programados reciben una organización explícita; no ejecutan consultas globales accidentales.

## 9. Acciones críticas y confirmación

Acciones críticas:

- cambio/revelación masiva de credenciales;
- cambio de correo/usuario o perfil;
- liberación;
- reemplazo;
- venta y renovación individual;
- cuenta caída y garantía de proveedor;
- pago, conversión Bs→USDT, costo, transferencia o salida de Bolsa;
- cierre/ajuste semanal;
- corrección de una operación confirmada;
- modificación de precio/costo/plantilla sensible.

Controles:

1. borrador con versión;
2. resumen enmascarado;
3. confirmación vinculada al borrador;
4. revalidación de permisos y estado;
5. transacción/idempotencia;
6. evento de auditoría de intento y resultado.

La operación de negocio no expira por inactividad y permanece pendiente hasta confirmación o cancelación explícita. La vigencia corta del callback es un control de canal independiente.

## 10. Matriz de auditoría

| Evento | Datos mínimos | Sensibilidad |
|---|---|---|
| `ACCESS_DENIED` | identidad externa, canal, razón, hora | No incluir mensaje completo si contiene secretos. |
| `CREDENTIAL_REVEALED` | actor, cuenta, propósito, canal, resultado | Nunca valor revelado. |
| `CREDENTIAL_CHANGED` | actor, cuenta, versión anterior/nueva, motivo, afectados | Nunca contraseña anterior o nueva. |
| `SALE_CONFIRMED` | operación, cliente, plan, slot, pago | Referencias y montos. |
| `RENEWAL_CONFIRMED` | item/suscripción, fechas anterior/nueva, pago propio | Una sola renovación por evento. |
| `ASSIGNMENT_RELEASED` | asignación, razón, actor | Crítico. |
| `INCIDENT_OPENED/RESOLVED` | cuenta, proveedor, decisión | Sin credenciales. |
| `ACCOUNT_REPLACED` | cuenta anterior/nueva, afectados | Crítico. |
| `PAYMENT/CASH_MOVEMENT` | origen, monto, moneda, receptor | Financiero. |
| `WEEKLY_CLOSURE` | semana, versión, totales, confirmador | Financiero. |
| `CONFIG_CHANGED` | clave, versión anterior/nueva redactada | No guardar secreto. |
| `DATA_EXPORT` | actor, alcance, motivo, resultado | Alto riesgo. |

## 11. Propiedades de auditoría

- Append-only para eventos confirmados.
- Identificador, timestamp UTC y `request_correlation_id`.
- Actor humano o proceso claramente distinguido.
- Organización y entidad afectada.
- Resultado `SUCCESS`, `DENIED`, `FAILED` o `UNKNOWN`.
- Metadatos redactados por lista permitida, no por “guardar todo y limpiar después”.
- Acceso a auditoría también auditado cuando sea sensible.
- Correcciones enlazadas a eventos/operaciones originales.

`PENDIENTE DE DECISIÓN`: plazo de retención y si se requiere un mecanismo criptográfico de encadenamiento/integridad.

## 12. Logs y observabilidad

Los logs técnicos deben incluir:

- nivel, componente, evento, correlación, duración y resultado;
- IDs opacos necesarios para diagnóstico;
- métricas de fallas, latencia, jobs y backups.

No deben incluir:

- contraseñas, tokens o llaves;
- cuerpos completos de Telegram/WhatsApp sin redacción;
- URLs `wa.me` completas, especialmente cuando contienen texto prellenado;
- URLs con tokens;
- dumps de borradores;
- filas completas importadas.

Configurar filtros de redacción antes de activar logs detallados.

Alertas mínimas:

- backup fallido;
- restauración de prueba fallida;
- tasa diaria fallida tras tres intentos;
- errores repetidos de autenticación;
- job matutino no ejecutado;
- espacio en disco bajo;
- servicio/base no saludable;
- operación crítica con resultado incierto.

## 13. Backups y restauración

Requisitos:

- backups automáticos cifrados;
- al menos una copia fuera del volumen principal del contenedor/base;
- política de retención configurable;
- verificación de integridad;
- restauración periódica en entorno aislado;
- documentación de RPO/RTO alcanzables;
- acceso solo de los responsables;
- llave de cifrado de backup almacenada separadamente.

Un backup no está “probado” hasta restaurarlo y validar datos/relaciones. La programación exacta y retención son `PENDIENTE DE DECISIÓN`, pero deben resolverse antes del corte.

## 14. Desarrollo y pruebas

- Solo datos falsos antes de migración.
- Fixtures no deben copiar teléfonos, correos o contraseñas reales.
- Pruebas de autorización, aislamiento e idempotencia obligatorias.
- Escaneo de dependencias y secretos antes de cada versión.
- Revisión de cambios en reglas financieras y de credenciales.
- Entorno de desarrollo no debe poder llegar a Sheets/n8n productivos.
- Variables de producción no se montan en desarrollo.

## 15. Migración segura

- Exportaciones reales se procesan en un entorno controlado y temporal.
- Acceso mínimo y con registro.
- No imprimir filas en consola.
- Reportes de validación usan conteos, hashes y excepciones redactadas.
- Los archivos temporales se eliminan de forma controlada tras verificación y aprobación.
- La importación no recibe permisos para modificar Sheets.
- La reversa no descifra/expone datos innecesariamente.

## 16. Operación segura para un equipo pequeño

Checklist periódico mínimo:

- confirmar que backups finalizaron;
- revisar alertas críticas;
- aplicar actualizaciones de seguridad en ventana planificada;
- revisar usuarios/identidades activas;
- rotar secretos cuando corresponda;
- probar restauración según calendario;
- revisar crecimiento de disco y logs;
- documentar cualquier incidente.

Automatizar verificaciones y notificaciones evita depender de recordar tareas diarias.

## 17. Respuesta a incidentes

1. Contener: deshabilitar identidad/token afectado sin borrar evidencia.
2. Preservar: capturar IDs, tiempos y logs redactados.
3. Evaluar: alcance por organización, cuentas, clientes y dinero.
4. Rotar: secretos y credenciales comprometidas.
5. Recuperar: restaurar servicio o datos desde fuente validada.
6. Notificar internamente a Gabriel y Edward.
7. Corregir y documentar causa raíz.

## 18. Criterios de aceptación de seguridad

- Una copia de la base sin llave no revela contraseñas de servicio.
- Una contraseña propia no puede recuperarse desde su almacenamiento.
- Un Telegram ID desconocido no obtiene datos.
- Un OWNER de otra organización no cruza frontera de datos.
- Logs y auditoría no contienen secretos tras pruebas de flujos completos.
- Doble callback no duplica operación.
- Callback expirado no elimina la operación y permite regenerar botones.
- Backup cifrado puede restaurarse y conciliarse.
- Cambio de contraseña registra ambas versiones como metadatos, sin conservar obligatoriamente el secreto anterior, y genera mensajes sin marcar envío.
- Acciones críticas no pueden confirmarse con un borrador antiguo.
- Un enlace WhatsApp autorizado contiene teléfono y mensaje completo correctos, abre directamente el chat y no queda en logs, auditoría ni analytics.
- Dos renovaciones solicitadas juntas producen eventos, pagos y movimientos independientes.
- Ningún job cierra Caja ni ejecuta otra acción crítica.

## 19. Pendientes de seguridad antes del corte

1. Algoritmo/librería concreta de cifrado y custodia de llave.
2. Contrato de autenticación/autorización para la integración futura del panel web; su implementación está fuera del alcance actual.
3. Zona horaria operacional.
4. RPO, RTO, frecuencia y retención de backups.
5. Retención de auditoría, logs, historial técnico de sesiones/contextos y mensajes; las operaciones pendientes quedan excluidas de eliminación por antigüedad.
6. Política de actualización del VPS.
7. Necesidad de segundo factor y acceso de emergencia.
