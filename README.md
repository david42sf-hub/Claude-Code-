# Diario de trading

Diario de trading personal para futuros operados en Tradovate: registra tus operaciones, calcula tus métricas y te ayuda a revisar cada día.

## Qué incluye

- **Panel**: resultado neto, tasa de acierto, factor de beneficio, expectativa, drawdown máximo, curva de capital, resultado por día y calendario mensual.
- **Operaciones**: tabla ordenable y filtrable; cada operación tiene estrategia, etiquetas, errores, notas, precio de stop (para el R múltiple), capturas de pantalla y el detalle de sus ejecuciones.
- **Diario**: notas por día junto a las operaciones de esa jornada.
- **Disciplina**: tus reglas (horario, pausa tras pérdidas seguidas, pérdida máxima por día y por operación, máximo de operaciones) se comprueban solas; muestra qué días las cumpliste, cuánto te costó romperlas y detecta patrones de comportamiento (sobreoperación, venganza, sobreconfianza, pérdidas aguantadas de más, días perfectos).
- **Playbooks**: escribe tus estrategias como reglas agrupadas, marca en cada operación qué reglas cumpliste y mira el cumplimiento medio y qué reglas te hacen ganar o perder dinero.
- **Noticias**: calendario económico por semana (filtro de impacto y país), tu resultado en días con noticias de alto impacto y una calculadora de tamaño de posición.
- **Asistente** (solo en la versión de una página publicada en Claude): chat con Claude que analiza el premercado y el mercado con velas y calendario reales, y opcionalmente con un resumen de tu diario.
- **Reportes**: resultado por símbolo, día de la semana, hora de entrada, duración, lado, estrategia, etiqueta y error.
- **Importar**: CSV de Tradovate (reportes *Performance* y *Fills*) y operaciones manuales. Reimportar no duplica nada.
- **Sincronización automática** con la API de Tradovate (solo lectura).

## Puesta en marcha

Requiere Node.js 22.13 o superior. No hay dependencias que instalar.

```bash
npm start        # abre http://localhost:3000
npm test         # pruebas automáticas
```

Los datos se guardan en la carpeta `data/` (base SQLite `diario.db` y capturas en `uploads/`). Respalda esa carpeta para conservar todo.

## Configuración

Copia `.env.example` a `.env` y completa lo que necesites. El archivo `.env` nunca se sube al repositorio.

| Variable | Para qué sirve |
|---|---|
| `PORT` | Puerto del servidor (3000 por defecto) |
| `APP_PASSWORD` | Contraseña de acceso. Obligatoria si publicas la app en internet |
| `DATA_DIR` | Carpeta de datos (por defecto `data/`) |
| `TRADOVATE_*`, `SYNC_MINUTES` | Sincronización automática (ver abajo) |

## Importar desde Tradovate

1. En Tradovate descarga el reporte **Performance** o **Fills** en CSV.
2. Súbelo en la pantalla **Importar**.
3. En **Ajustes** indica la comisión por contrato y por lado de cada instrumento: el reporte Performance no trae comisiones, y sin ellas el resultado neto sería igual al bruto.

Las horas del CSV se interpretan en la zona horaria elegida en Ajustes (por defecto `America/New_York`).

## Sincronización automática

1. Activa el complemento **API Access** en tu cuenta de Tradovate y genera una clave de API (`cid` y `secret`).
2. Completa en `.env` las variables `TRADOVATE_USER`, `TRADOVATE_PASSWORD`, `TRADOVATE_CID` y `TRADOVATE_SEC`. Usa `TRADOVATE_ENV=demo` para probar contra el entorno de simulación.
3. Reinicia la app. Descargará las ejecuciones cada `SYNC_MINUTES` minutos y también con el botón **Sincronizar ahora**.

La app solo lee cuentas, órdenes, ejecuciones y comisiones; no envía órdenes. Las ejecuciones que ya estaban importadas por CSV no se duplican y reciben la comisión real que informa Tradovate.

**Estado**: la sincronización sigue la documentación pública de la API y está probada contra una API simulada, pero todavía no contra una cuenta real. Falta confirmar con una cuenta real cuánto historial devuelve Tradovate; el historial anterior se carga por CSV.

## Cómo se calculan las operaciones

Una operación va de posición plana a posición plana, por cuenta y contrato, agrupando entradas y salidas parciales. Si una ejecución invierte la posición, se divide en dos operaciones. El resultado bruto es la diferencia de precio por la cantidad y por el valor por punto del instrumento; el neto descuenta comisiones. Cada operación pertenece al día de su cierre.

## Publicarla

Para que sincronice sin tener tu computadora encendida, despliégala en un servidor con Node 22 y disco persistente para `data/`, detrás de HTTPS y con `APP_PASSWORD` definida.

## Versión de una sola página

`node scripts/build-artifact.mjs` genera `dist/diario-de-trading.html`: la misma interfaz sin servidor, con los datos guardados en el navegador o en el espacio de datos de la página donde se publique. No incluye sincronización con la API ni capturas de pantalla.

Al publicarla con Claude se declaran los permisos `db`, `user`, `sample` y `mcp` (conector de Tradezella, solo las herramientas `get_market_data` y `get_economic_calendar`). Esas consultas envían símbolo, fechas e impacto; nunca operaciones, notas ni playbooks. En la versión con servidor, el calendario usa un feed público gratuito de la semana en curso y el asistente no está disponible.

## Borrar los datos

Ajustes → **Borrar todos los datos** elimina operaciones, notas, capturas y playbooks, y deja solo NQ y MNQ como instrumentos. Conserva la zona horaria, las reglas y las comisiones de NQ y MNQ.
