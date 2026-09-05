# 09 — Plan de migración

## 1. Objetivo

Mover la fuente de verdad de Google Sheets a PostgreSQL sin interrumpir el sistema productivo hasta que V2 esté probado y aprobado.

La migración no es una sincronización permanente. Es un proceso con exportación, normalización, importación, validación, corte y ventana de reversa.

## 2. Reglas inviolables

- Google Sheets continúa como producción durante el desarrollo.
- n8n y el bot actuales no se modifican.
- PostgreSQL de desarrollo contiene datos falsos.
- No existe dual-write inicial.
- No se usan credenciales reales en desarrollo.
- No se ejecuta importación real antes de aprobar ensayo, seguridad, backup y reversa.
- Solo Netflix y FlujoTV forman parte del mapeo funcional actual; no se crean transformaciones para otros servicios.
- Sheets no se elimina después del corte; queda temporalmente read-only.
- El sistema viejo se retira solo tras validación estable.

## 3. Estados de convivencia

| Etapa | Fuente de verdad | V1 | V2 |
|---|---|---|---|
| Diseño/desarrollo | Sheets | Activo | Datos ficticios, sin acceso productivo |
| Ensayo de migración | Sheets | Activo | Copia aislada de exportación, no operativa |
| Pre-corte | Sheets | Activo | Validado, bloqueado para escritura real |
| Ventana de corte | Sheets hasta congelación; luego PostgreSQL | Congelado temporalmente | Importación final y validación |
| Estabilización | PostgreSQL | Sheets read-only como referencia | Activo |
| Retiro | PostgreSQL | Archivado según decisión | Activo |

## 4. Fase M0 — Preparación documental

Entregables:

- esta especificación aprobada;
- inventario de fuentes/hojas/workflows;
- diccionario real de columnas;
- lista de decisiones pendientes y responsables;
- clasificación de datos sensibles;
- criterios de aceptación de migración.

Puerta M0: no iniciar diseño de importador si las reglas que cambian fechas, costos o asignaciones continúan ambiguas.

## 5. Fase M1 — Perfilado read-only

Sobre una exportación controlada, nunca modificando Sheets:

1. contar filas por hoja;
2. identificar encabezados y tipos reales;
3. medir nulos, duplicados y formatos;
4. detectar teléfonos equivalentes;
5. detectar cuentas/usuarios duplicados;
6. identificar perfiles libres, asignados, vencidos y estados contradictorios;
7. localizar relaciones por `row_number`/texto;
8. identificar fechas inválidas;
9. separar filas de configuración, historial y estado temporal;
10. generar reporte sin imprimir secretos.

El perfilado debe registrar excepciones con IDs/hashes redactados, no con credenciales.

## 6. Fase M2 — Diccionario y mapeo

Cada columna de origen recibe una clasificación:

- **migrar directamente:** valor de negocio válido;
- **normalizar:** requiere formato, catálogo o relación;
- **derivar:** se recalcula desde otros hechos;
- **archivar:** se conserva solo como evidencia histórica;
- **descartar:** estado temporal/técnico sin valor futuro;
- **pendiente:** significado no confirmado.

Ejemplos de mapeo:

| Origen | Destino lógico | Tratamiento |
|---|---|---|
| `NETFLIX.CORREO` | `service_accounts.login_identifier_*` | Normalizar y deduplicar dentro de servicio. |
| `NETFLIX.CONTRASEÑA` | `credential_versions` | Cifrar en el proceso autorizado; nunca loguear. |
| `NETFLIX.PERFIL` | `account_slots` + `subscriptions` | Parsear perfil/modalidad; revisar excepciones. |
| `NOMBRE` | `customers.display_name` | Normalizar espacios; no unir solo por nombre. |
| `NUMERO` | `phones` + `customer_phones` | Conservar original y canónico; admitir muchos-a-muchos. |
| `ESTADO` de cliente | `customers.location_text` | Confirmar significado; no confundir con status. |
| `FECHA DE INICIO` | `subscriptions.starts_on` | Parsear fecha con zona/regla aprobada. |
| `FECHA QUE ACABA` | `subscriptions.expires_on` | Guardar fecha; derivar vigencia. |
| `ACOTACION` | actor/nota según evidencia | Mapear Gabriel/Edward; excepciones a revisión. |
| `MONTO` | operación/pago histórico | No inferir método/receptor ausente. |
| `LOGS_CHAT` | estado conversacional heredado | Identificar toda operación activa y exigir confirmación/cancelación explícita antes del corte, o mapearla de forma aprobada; nunca descartarla por timeout. |
| `LOGS_CAJA` | operaciones pendientes | Resolver/cancelar antes del corte; no importar como confirmadas. |
| acumuladores `CAJA` | no usar como libro | Reconstruir desde historial y conciliar con totales. |
| `Tasas_Bot` | `exchange_rates` y políticas | Separar tasa, precios e historia. |

Las renovaciones múltiples/consolidadas encontradas en V1 se archivan como comportamiento histórico. **COMPORTAMIENTO V1 QUE NO SE ADOPTA EN V2:** no se crea `RENOVACION_MULTIPLE`, selección `Todas`, pago consolidado ni rollback conjunto. Para hechos históricos, el mapeo debe conservar su evidencia y descomponer relaciones solo mediante una regla aprobada, sin inventar pagos.

## 7. Fase M3 — Datos ficticios y pruebas del importador

Construir fixtures sintéticos que cubran:

- cliente con varios teléfonos;
- teléfono compartido entre clientes;
- teléfono inexistente en búsqueda normal sin creación de datos y alta del mismo número solo dentro de Venta nueva;
- cuenta Netflix parcial/completa/emergencia;
- prioridad Netflix: comercial en cuenta parcial, luego cuenta libre y emergencia solo confirmada;
- FlujoTV compartida y completa;
- vencidos activos con 0, -1, -30 y -100 días, agrupados/ordenados y aún ocupando inventario;
- liberación de vencido con Seguimiento automático y credencial pendiente o ya actualizada desde la misma fuente de verdad;
- Venta nueva sin inventario y sin alta, Seguimiento, espera, reserva ni asignación;
- dos renovaciones solicitadas juntas y procesadas como operaciones independientes;
- corrección de borrador antes de confirmar y ajuste trazable después de confirmar;
- callback expirado que regenera botones sin cancelar el borrador;
- mensajes WhatsApp completos, directos y específicos por cliente afectado sin persistir la URL;
- consulta de código FlujoTV por variantes de lenguaje natural;
- cuenta caída esperando proveedor;
- reemplazo con pausa;
- pagos por cada método/receptor;
- cierre semanal y ajustes;
- semana terminada sin cierre automático;
- duplicados/fechas inválidas.

El importador debe ser repetible en una base vacía y producir el mismo resultado. No debe conectarse a Sheets productivo.

## 8. Fase M4 — Ensayo con exportación real aislada

Solo tras aprobación y en entorno controlado:

1. generar exportación puntual read-only;
2. calcular hash y registrar hora/corte;
3. copiarla al entorno de migración protegido;
4. perfilar y transformar;
5. cifrar secretos durante carga;
6. importar a base de ensayo aislada;
7. ejecutar conciliación;
8. producir lista de excepciones redactadas;
9. corregir reglas/mapeo, no editar ciegamente origen;
10. repetir hasta aceptación.

## 9. Conciliación obligatoria

### 9.1 Conteos

- clientes únicos y relaciones teléfono;
- cuentas por servicio/estado/proveedor;
- slots por categoría/estado;
- asignaciones activas/liberadas;
- vencidos/por vencer;
- ventas/renovaciones por periodo;
- incidencias abiertas;
- movimientos por moneda/método/receptor;
- Bolsas y cierres disponibles.

### 9.2 Relaciones

- toda asignación apunta a cliente, plan, cuenta y slot válidos;
- ningún slot exclusivo tiene dos asignaciones activas;
- vencidos asignados continúan ocupados;
- toda cuenta/perfil con cliente en Sheets tiene correspondencia o excepción explícita;
- reemplazos no pierden cuenta anterior;
- teléfonos compartidos no fusionan clientes indebidamente.

### 9.3 Finanzas

- comparar totales por semana, servicio, modalidad, moneda y receptor;
- explicar diferencias por reglas conocidas;
- no forzar igualdad mediante asientos sin evidencia;
- registrar saldos iniciales de Bolsas con fecha y aprobación;
- separar adquisiciones de costo reconocido.

### 9.4 Secretos

- ninguna contraseña aparece en reportes/logs;
- una muestra autorizada puede descifrarse y coincidir sin mostrar su valor;
- claves no están en la base ni exportación del repositorio.

## 10. Manejo de excepciones

Cada excepción se clasifica:

- dato corregible con regla determinista;
- decisión manual con evidencia;
- dato incompleto que puede migrarse marcado;
- bloqueante de corte;
- registro no migrable que se archiva.

Las decisiones manuales deben guardar responsable, fecha, motivo, referencia de origen redactada y resultado. No editar el dataset exportado sin dejar transformación reproducible.

## 11. Preparación del corte

Requisitos previos:

- V2 aprobado por Gabriel y Edward con datos falsos;
- ensayo real conciliado;
- backup/restauración de PostgreSQL probados;
- exportación/transformación/importación automatizadas y repetibles;
- lista de pendientes no bloqueantes aprobada;
- plan de comunicación y ventana;
- procedimiento de congelación de V1;
- rollback ensayado;
- observabilidad y soporte listos.

Definir responsables de `GO/NO-GO`. Por equivalencia de roles, ambos OWNER deben revisar; la regla exacta de unanimidad es `PENDIENTE DE DECISIÓN`.

## 12. Corte controlado

Orden propuesto:

1. anunciar inicio de ventana;
2. impedir nuevas escrituras operativas en V1 de forma controlada;
3. confirmar que no existen operaciones de Telegram/Caja pendientes;
4. registrar hora exacta de congelación;
5. exportar Sheets final y calcular hash;
6. realizar backups de V1 y PostgreSQL destino;
7. ejecutar transformación/importación final;
8. correr conciliación automática y revisión de excepciones;
9. realizar pruebas rápidas de lectura, venta simulada controlada, renovación individual, credenciales, WhatsApp directo, Caja y auditoría;
10. decisión `GO/NO-GO`;
11. si `GO`, activar V2 como única ruta de escritura;
12. colocar Sheets read-only;
13. monitorear intensivamente.

No se permite que V1 y V2 acepten escrituras simultáneas durante la transición.

Una operación pendiente no puede cerrarse por antigüedad para despejar el corte. Gabriel o Edward deben confirmarla o cancelarla explícitamente; si se aprueba migrarla como borrador, debe conservar su estado y continuar pendiente en V2.

## 13. Rollback

Se activa si:

- falla conciliación crítica;
- aparecen asignaciones o saldos inconsistentes;
- V2 no puede completar operaciones críticas;
- hay exposición de secretos;
- el resultado de escrituras es incierto.

Antes de cualquier escritura real en V2, el rollback es directo: mantener V1 como fuente de verdad.

Después de escrituras reales en V2, volver a V1 requiere un procedimiento de reconciliación de esas operaciones; no se debe copiar manualmente sin control. Por eso la ventana inicial debe minimizar operaciones y definir un punto de no retorno.

Pasos mínimos:

1. detener nuevas escrituras en V2;
2. preservar base/logs para diagnóstico;
3. contar operaciones confirmadas desde el corte;
4. aplicar plan aprobado de reintegración o anulación;
5. reactivar V1 solo cuando las operaciones estén reconciliadas;
6. comunicar estado y documentar causa.

## 14. Estabilización

Durante el periodo posterior:

- Sheets permanece read-only;
- comparar diariamente conteos, asignaciones y movimientos;
- revisar errores, tasa, jobs y backups;
- verificar mensajes/credenciales con muestras autorizadas;
- registrar ajustes de migración por operación trazable;
- no borrar infraestructura o archivos de V1.

Duración del periodo de estabilización es `PENDIENTE DE DECISIÓN`.

## 15. Retiro de V1

Solo cuando:

- terminó estabilización;
- no hay diferencias críticas;
- backups y restauración de V2 funcionan;
- ambos OWNER aprueban;
- exportaciones finales y documentación se conservan según retención.

El retiro debe ser una tarea separada y explícita. Esta especificación no autoriza borrar Sheets, workflows ni volúmenes.

## 16. Criterios de aceptación de migración

- 100% de registros críticos migrados o clasificados como excepción aprobada.
- 0 asignaciones exclusivas duplicadas.
- 0 secretos en reportes/logs.
- Totales financieros conciliados o diferencias explicadas y aprobadas.
- Saldos iniciales de Bolsas confirmados.
- Consultas por teléfono/cuenta producen resultados esperados.
- Búsqueda normal sin cliente no crea registros y Venta nueva sin inventario no crea espera, seguimiento, reserva ni asignación.
- Vencidos no aparecen como libres.
- Renovaciones de servicios distintos permanecen separadas en operación, pago, Caja y auditoría.
- Preparaciones WhatsApp abren el cliente correcto con el mensaje completo y no persisten URLs sensibles.
- Restauración de backup probada.
- Corte y rollback ensayados.
- Sheets permanece intacto hasta la ventana y read-only después del `GO`.

## 17. Artefactos de migración requeridos

- diccionario de datos de origen;
- mapeo origen→destino versionado;
- perfilado redactado;
- catálogo de transformaciones;
- reporte de excepciones;
- reporte de conciliación;
- hashes de exportaciones;
- checklist de corte;
- checklist de rollback;
- acta de `GO/NO-GO`;
- informe de estabilización.
