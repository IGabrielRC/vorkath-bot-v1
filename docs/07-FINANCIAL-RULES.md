# 07 — Reglas financieras

## 1. Objetivo

Vorkath controla operaciones internas de Caja y Bolsas. No pretende sustituir contabilidad fiscal. Debe permitir explicar cada cifra desde movimientos inmutables, políticas versionadas y un cierre manual.

Las reglas por servicio de esta versión se limitan a Netflix y FlujoTV.

## 2. Conceptos separados

### Caja

Representa dinero recibido o registrado durante ventas, renovaciones y otros movimientos operacionales. Responde:

- cuánto se vendió;
- cuánto dinero entró;
- quién lo recibió;
- por qué método y moneda;
- qué operación lo originó.

### Bolsa

Representa capital acumulado del negocio utilizado para reposición, publicidad, ChatGPT, comisiones, costos y otros gastos. No empieza en cero cada semana.

Bolsas iniciales:

- **Bolsa Zelle**, USD;
- **Bolsa Binance**, USDT.

### Custodio/receptor

Gabriel o Edward pueden tener dinero recibido aún no consolidado en una Bolsa. `RECIBIDO_POR` no se deduce de `OPERADOR`.

## 3. Principios del libro

- **FIN-LED-001:** Todo saldo se deriva de movimientos; no se reemplaza manualmente un total.
- **FIN-LED-002:** Un movimiento confirmado es inmutable.
- **FIN-LED-003:** Errores se corrigen mediante reversa o ajuste enlazado.
- **FIN-LED-004:** Cada movimiento identifica moneda; no sumar monedas distintas sin conversión documentada.
- **FIN-LED-005:** Cada conversión conserva monto origen, monto destino y tasa real.
- **FIN-LED-006:** Cada operación posee clave de idempotencia.
- **FIN-LED-007:** Los reportes excluyen borradores, fallidos y cancelados.
- **FIN-LED-008:** Un borrador de Caja o cierre no expira por inactividad; permanece pendiente hasta confirmación o cancelación explícita.

## 4. Semana operacional

La semana va de lunes a domingo. La vista principal muestra la semana que contiene la fecha operacional actual.

La semana permanece abierta hasta confirmación manual, aunque ya haya terminado el domingo. El cierre puede realizarse domingo, lunes, martes o posteriormente. Un job solo puede avisar `Semana pendiente de cierre`; nunca crea ni confirma el cierre.

`PENDIENTE DE DECISIÓN`: zona horaria operacional que determina inicio y fin del día.

## 5. Ventas y dinero recibido

### 5.1 Registro por operación

Cada venta/renovación conserva:

- tipo de operación;
- servicio y modalidad;
- cantidad/duración;
- precio unitario vigente aplicado;
- monto sugerido;
- monto real recibido;
- moneda y método;
- tasa/equivalencia si aplica;
- receptor;
- operador;
- fecha/hora;
- cliente y operación origen.

El **monto real recibido** es la verdad de Caja. La diferencia respecto del sugerido queda visible, no se corrige ocultamente.

Cada renovación de una suscripción/servicio es una operación financiera independiente. Renovar Netflix y FlujoTV requiere dos borradores, dos confirmaciones, pagos propios, movimientos de Caja propios, auditorías propias y transacciones propias. No existe pago ni rollback consolidado entre renovaciones.

### 5.2 Métodos actuales

| Método | Moneda normal | Conversión para referencia |
|---|---|---|
| Pago Móvil | VES | precio USD × tasa diaria aplicada |
| Zelle | USD | nominal USD |
| Binance | USDT | nominal USDT |

No asumir paridad contable USD/USDT fuera de la política de reportes aprobada. Para mostrar un total combinado, el reporte debe declarar la convención usada.

### 5.3 Pagos divididos

El modelo admite varios pagos asociados a una operación, pero la UX/regla inicial está `PENDIENTE DE DECISIÓN`. Hasta resolverlo, una operación no debe dividirse de forma implícita.

## 6. Tasa diaria

- Se obtiene aproximadamente a las 08:30, hora configurable.
- Se realizan 3 intentos con 3 segundos entre intentos.
- Una tasa válida se identifica por fecha, par de monedas, fuente y hora.
- Si fallan los tres intentos, se avisa a ambos OWNER y solo se ofrece `Reintentar` o `Ingresar tasa manual`.
- La tasa manual requiere actor y queda marcada `MANUAL`.
- La tasa de un día anterior no se presenta ni se usa como tasa actual.

El cálculo sugerido en bolívares debe guardar la tasa exacta usada, incluso si luego cambia la tasa configurada.

## 7. Costos operativos variables

Política inicial configurable:

| Unidad vendida | Costo reconocido |
|---|---:|
| Netflix perfil | 2.00 USD |
| FlujoTV perfil | 1.50 USD |
| FlujoTV cuenta completa | 3.50 USD |

Fórmula por ítem:

`costo_reconocido = unidades_facturables × costo_unitario_versionado`

Ejemplo aprobado: 100 perfiles Netflix vendidos reconocen 200 USD de costo operativo.

Cada ítem de operación debe conservar la política y valor aplicados para que una modificación futura no altere semanas pasadas.

### 7.1 Renovaciones por duración

Para meses completos, el costo debe corresponder a la unidad/duración vendida según política. El tratamiento exacto de días, fracciones, redondeo y promociones es `PENDIENTE DE DECISIÓN` y no debe copiarse automáticamente del workflow actual.

### 7.2 Netflix completa

Precio y costo operativo son `PENDIENTE DE DECISIÓN`.

## 8. Adquisición física e impedimento de doble costo

La compra de cuentas al proveedor se registra como adquisición de inventario y salida real de dinero si fue pagada. Sin embargo, el cálculo semanal de beneficio no debe restarla otra vez si el costo económico ya fue reconocido mediante costo por unidad vendida.

Para evitar doble contabilización, cada salida debe clasificar:

- `INVENTORY_ACQUISITION_CASH`: movimiento real de Bolsa;
- `OPERATIONAL_COST_RECOGNITION`: costo atribuido a ventas;
- `EXPENSE_PAYMENT`: pago de costo/gasto;
- `TRANSFER`: traslado entre custodios/Bolsas.

El reporte de beneficio usa el reconocimiento definido, no suma ciegamente todas las salidas de efectivo.

## 9. Costos recurrentes

Política inicial configurable:

| Concepto | Monto | Frecuencia | Imputación semanal actual |
|---|---:|---|---:|
| Publicidad | 20 USD | semanal | 20 USD |
| Zelle | 5 USD | mensual | 1.25 USD |
| ChatGPT | 20 USD | mensual | 5 USD |

Los costos mensuales se distribuyen entre cuatro semanas bajo la política actual. Monto, moneda, frecuencia y estado activo/inactivo son editables; la política y sus valores deben versionarse y no quedar hardcodeados en el core.

Un costo reconocido y su pago real son hechos distintos:

- el reconocimiento participa en el cálculo de beneficio;
- el pago reduce una Bolsa cuando ocurre.

## 10. Pagos desde Bolsa

Cada pago registra obligatoriamente:

- concepto;
- monto;
- moneda;
- Bolsa de origen;
- fecha/hora;
- operador;
- política/costo relacionado si existe;
- referencia o nota opcional.

No se permite saldo negativo de una Bolsa salvo que exista una política explícita futura. Si no hay fondos suficientes, el borrador debe advertir y bloquear o solicitar una decisión autorizada; dicha política adicional está pendiente.

## 11. Transferencias y consolidación

Una transferencia conserva dos lados correlacionados:

- salida del origen;
- entrada al destino.

Si hay conversión VES→USDT, se guarda:

- custodio/origen de VES;
- VES utilizados;
- USDT adquiridos;
- tasa real de compra;
- fees si existen;
- destino Bolsa Binance;
- fecha y operador.

La tasa real de compra no se sustituye por la tasa diaria de venta.

## 12. Vista semanal requerida

Debe mostrar, sin mezclar monedas de forma engañosa:

- ventas totales;
- ventas por servicio/modalidad;
- dinero recibido por moneda;
- dinero por Gabriel y Edward;
- dinero por método;
- costos variables reconocidos;
- costos recurrentes imputados;
- pagos de costos realizados;
- movimientos hacia/desde Bolsas;
- saldos de Bolsas;
- resultado provisional;
- partidas pendientes de consolidación.

## 13. Orden contractual del cierre semanal

El asistente debe guiar exactamente este orden:

1. revisar ventas;
2. revisar dinero esperado de Gabriel/Edward;
3. consolidar bolívares;
4. normalmente Gabriel transfiere sus Bs a Edward;
5. realizar una sola compra de USDT;
6. registrar bolívares utilizados;
7. registrar USDT adquiridos;
8. registrar tasa real de compra;
9. llevar USDT a Bolsa Binance;
10. mantener/llevar USD a Bolsa Zelle;
11. asegurar costos operativos;
12. calcular excedente;
13. calcular beneficio;
14. dividir beneficio 50/50;
15. revisar;
16. confirmar cierre manualmente.

“Normalmente Gabriel transfiere” describe el flujo habitual, no autoriza inventar una transferencia. Cada cierre registra lo que realmente ocurrió.

## 14. Cálculo provisional

Por semana y con valores llevados a una base de reporte claramente identificada:

- **Ingresos reconocidos:** suma de ventas/renovaciones confirmadas.
- **Costos variables:** suma de costos por ítem vendidos según política vigente al operar.
- **Costos recurrentes:** imputación semanal según política versionada.
- **Excedente antes de reparto:** ingresos reconocidos menos costos variables y recurrentes aplicables.
- **Beneficio repartible:** excedente después de asegurar los costos y resolver ajustes aprobados.
- **Participación:** 50% Gabriel y 50% Edward, configurable.

El cálculo no debe confundir disponibilidad de efectivo por moneda con beneficio. Una semana puede tener beneficio calculado y dinero aún en custodia/no convertido.

## 15. Confirmación del cierre

Antes de confirmar, mostrar:

- rango lunes–domingo;
- conteos y dinero por servicio;
- dinero por receptor/moneda;
- conversiones reales;
- saldos llevados a Bolsas;
- costos y políticas aplicadas;
- beneficio y división;
- advertencias o diferencias.

Confirmar crea un snapshot inmutable y eventos de auditoría. No ejecuta acciones bancarias ni transferencias externas.

Nada del cierre —incluidos consolidación, conversión, costos o reparto— se ejecuta por calendario. Cada escritura financiera crítica requiere borrador, revisión, confirmación explícita y trazabilidad.

## 16. Correcciones posteriores

Un cierre confirmado no se reescribe. Si aparece una venta omitida, pago equivocado o costo tardío:

1. registrar el ajuste/reversa;
2. enlazarlo al movimiento y cierre original;
3. recalcular una versión de ajuste;
4. mostrar diferencia de reparto;
5. confirmar el ajuste.

## 17. Ejemplo semanal simplificado

Supuesto solo ilustrativo con reglas aprobadas:

- 10 perfiles Netflix vendidos a 4 USD = 40 USD de ingresos;
- costo variable: 10 × 2 USD = 20 USD;
- publicidad semanal = 20 USD;
- Zelle mensual prorrateado = 1.25 USD;
- ChatGPT mensual prorrateado = 5 USD.

Resultado: 40 − 20 − 20 − 1.25 − 5 = **−6.25 USD**. No hay beneficio repartible. Este cálculo demuestra que primero se cubren costos; no representa una semana real.

## 18. Validaciones financieras mínimas

- monto mayor que cero salvo reversa explícita;
- moneda y método compatibles o justificados;
- receptor obligatorio;
- política de precio/costo vigente y versionada;
- una fuente no genera dos movimientos;
- tasa positiva y fechada cuando hay conversión;
- cierre sin operaciones pendientes inciertas;
- ninguna renovación agrupa pagos o movimientos de servicios distintos;
- cierre no automático aunque la semana haya terminado;
- igualdad de lados en transferencias, considerando conversión/fees;
- ninguna contraseña ni token en concepto/referencia.

## 19. Pendientes financieros

1. Prorrateo por días y redondeo.
2. Precio/costo de Netflix completa.
3. Promociones 6→7 y 12→14 de FlujoTV.
4. Concepto “crédito FlujoTV” y si es adquisición, gasto o inventario.
5. Pagos divididos.
6. Convención para reportar USD y USDT juntos.
7. Política ante saldo insuficiente en Bolsa.
8. Tratamiento de fees de Zelle/Binance no incluidos en costos actuales.
