# 💸 Mis Gastos

Control de gastos personal: resumen visual del mes, movimientos, gastos/ingresos fijos y proyección a 6/12/24 meses.

- Un solo archivo (`index.html`), sin build.
- Datos en Supabase (tabla `gas_estado`, un documento JSON por usuario con RLS). Antes del primer login hay que correr `gastos-schema.sql` una vez en el SQL editor.
- `?demo` al final de la URL abre la app con datos de ejemplo, sin tocar la nube.
