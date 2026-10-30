# Sistema Forrajera

Inventario y ventas para una forrajera: alimento balanceado, granos, forrajes, sales y medicinas, que se venden **por bulto** o **a granel (por kilo)**.

Es una app web instalable (PWA): funciona en el navegador y se instala en celular o computadora desde el propio sitio.

## Qué hace

- **Inventario en bultos cerrados y bulto abierto.** Cada producto a granel lleva por separado los bultos enteros y los kg que quedan en el bulto abierto, por ejemplo «12 bultos cerrados + 15 kg abierto». El botón **Abrir bulto** pasa un bulto de cerrados al abierto.
- **Notas de venta** con varios renglones, cliente y folio. Las ventas por bulto salen de los bultos cerrados. Las ventas a granel salen del bulto abierto, y si no alcanza, el sistema abre los bultos necesarios y lo deja anotado en el historial.
- **Compras** en bultos (entran como cerrados) o en kilos (se suman al abierto), con costo, proveedor y factura.
- **Alertas** de lo que se está acabando y **pedido sugerido** en bultos.
- **Metas de venta** del mes con gráficas de avance, ventas por mes y por producto.
- **Reportes** en PDF, imagen y CSV, y **respaldo** de los datos.
- **Usuarios** administrador y encargado de tienda, con **código de app autenticadora** (Google o Microsoft Authenticator) obligatorio para entrar.

## Cómo está hecho

- `index.html`, `app.js`: la app (HTML y JavaScript, sin compilación).
- `db.js`: capa de datos sobre la tabla `forr_docs` de Supabase, con cambios en tiempo real.
- `config.js`: dirección del proyecto de Supabase y su llave **publicable**. Esa llave está hecha para ir en el navegador; los permisos los controla la base de datos con Row Level Security.
- `sw.js`, `manifest.webmanifest`, íconos: lo que la hace instalable.
- `_headers`: cabeceras de seguridad para Netlify (CSP, HSTS, etc.).
- `vendor/`: copia local de `@supabase/supabase-js` 2.45.4.
- `supabase/`: el SQL de la base de datos, en orden (`01_base.sql`, `02_bultos_cerrados_y_abierto.sql`).

## Base de datos (Supabase)

- `forr_docs` y `forr_profiles` guardan los datos y usuarios de la app, con reglas por rol (administrador o encargado de su tienda) y exigiendo sesión verificada con el autenticador (`aal2`).
- Las tablas y vistas `forrajera_*` (inventario, ventas, compras, entradas y salidas, bultos abiertos, metas…) se llenan solas con triggers y sirven para consultar todo en español desde el panel de Supabase. No son accesibles desde la API.

Para montarla en un proyecto nuevo: ejecuta los archivos de `supabase/` en orden en el SQL Editor de Supabase y pon la URL y la llave publicable del proyecto en `config.js`.

## Publicar

Está publicado con **GitHub Pages** desde la rama `main`: https://edwinalejandro0824-web.github.io/sistema-forrajera/ (cada cambio en `main` se publica solo).

También funciona en cualquier hosting estático. En Netlify se puede conectar este repositorio (sin comando de compilación y con la carpeta raíz como carpeta de publicación) o subir la carpeta comprimida en Netlify Drop.
