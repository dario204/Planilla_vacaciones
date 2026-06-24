require('dotenv').config();
const express      = require('express');
const cors         = require('cors');
const jwt          = require('jsonwebtoken');
const bcrypt       = require('bcryptjs');
const path         = require('path');
const fs           = require('fs');
const { exec }     = require('child_process');
const rateLimit    = require('express-rate-limit');
const helmet       = require('helmet');
const pool         = require('./db');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Validar que las variables de entorno críticas existan al arrancar ────────
['JWT_SECRET', 'APP_PASSWORD_HASH', 'DATABASE_URL'].forEach(key => {
  if (!process.env[key]) {
    console.error(`❌ Variable de entorno faltante: ${key}. El servidor no puede iniciar.`);
    process.exit(1);
  }
});
if (process.env.JWT_SECRET === 'cambia_esta_clave_secreta_por_algo_largo_y_aleatorio_2026') {
  console.error('❌ JWT_SECRET tiene el valor por defecto. Cambialo en el archivo .env antes de usar en producción.');
  process.exit(1);
}

// ── Cabeceras de seguridad HTTP (Helmet) ────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'"],
      styleSrc:   ["'self'", "https://fonts.googleapis.com", "'unsafe-inline'"],
      fontSrc:    ["'self'", "https://fonts.gstatic.com"],
      imgSrc:     ["'self'", "data:"],
      connectSrc: ["'self'"],
    }
  }
}));

// ── CORS: solo permitir el mismo origen (localhost en producción local) ──────
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || `http://localhost:${PORT}`,
  methods: ['GET', 'POST', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json({ limit: '10kb' })); // Limitar tamaño del body

// ── Servir el frontend estático ──────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../front-end')));

// ── Rate limiting: login (máx. 5 intentos por IP cada 15 min) ───────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Demasiados intentos fallidos. Esperá 15 minutos e intentá de nuevo.' },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true, // Solo cuenta los intentos fallidos
});

// ── Rate limiting: API general (máx. 200 requests por IP cada 15 min) ───────
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: { error: 'Demasiadas solicitudes. Esperá unos minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ── Middleware: verificar JWT en todas las rutas /api ────────────────────────
function auth(req, res, next) {
  const header = req.headers['authorization'];
  const token  = header && header.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No autorizado' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Sesión inválida o expirada. Volvé a iniciar sesión.' });
  }
}

// ── Helpers de validación ────────────────────────────────────────────────────
function isPositiveInt(val) {
  const n = parseInt(val, 10);
  return Number.isFinite(n) && n > 0 && String(n) === String(val).trim();
}

function sanitizeText(val, maxLen = 200) {
  if (typeof val !== 'string') return '';
  return val.trim().slice(0, maxLen);
}

// ── POST /api/login ──────────────────────────────────────────────────────────
app.post('/api/login', loginLimiter, (req, res) => {
  const { password } = req.body;
  if (!password || typeof password !== 'string')
    return res.status(400).json({ error: 'Contraseña requerida' });

  // Limitar longitud para evitar ataques de bcrypt con strings muy largas
  if (password.length > 128)
    return res.status(400).json({ error: 'Contraseña inválida' });

  const hash = process.env.APP_PASSWORD_HASH;
  const ok   = bcrypt.compareSync(password, hash);

  // Respuesta idéntica en tiempo y mensaje para contraseña correcta/incorrecta
  // (evita que se pueda detectar si el usuario existe o no)
  if (!ok) return res.status(401).json({ error: 'Contraseña incorrecta' });

  const token = jwt.sign({ app: 'vacaciones' }, process.env.JWT_SECRET, { expiresIn: '8h' });
  res.json({ token, expiresIn: 28800 });
});

// ── POST /api/cambiar-password ───────────────────────────────────────────────
app.post('/api/cambiar-password', auth, (req, res) => {
  const { nueva } = req.body;
  if (!nueva || typeof nueva !== 'string' || nueva.length < 6)
    return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
  if (nueva.length > 128)
    return res.status(400).json({ error: 'La contraseña no puede superar los 128 caracteres' });

  const hash    = bcrypt.hashSync(nueva, 10);
  const envPath = path.join(__dirname, '.env');

  // Validar que el path del .env es el esperado (evita path traversal)
  const resolvedPath = path.resolve(envPath);
  const expectedBase = path.resolve(__dirname);
  if (!resolvedPath.startsWith(expectedBase)) {
    return res.status(500).json({ error: 'Error interno de configuración' });
  }

  try {
    let contenido = fs.readFileSync(envPath, 'utf8');
    if (/^APP_PASSWORD_HASH=.*/m.test(contenido)) {
      contenido = contenido.replace(/^APP_PASSWORD_HASH=.*/m, `APP_PASSWORD_HASH=${hash}`);
    } else {
      contenido += `\nAPP_PASSWORD_HASH=${hash}`;
    }
    fs.writeFileSync(envPath, contenido, 'utf8');
  } catch (err) {
    return res.status(500).json({ error: 'No se pudo actualizar el archivo .env: ' + err.message });
  }

  process.env.APP_PASSWORD_HASH = hash;

  exec('pm2 restart all', (err) => {
    if (err) console.warn('PM2 no disponible o error al reiniciar:', err.message);
  });

  res.json({ message: 'Contraseña actualizada correctamente. La sesión actual sigue activa.' });
});

// ── Todas las rutas /api requieren autenticación + rate limiting ─────────────
app.use('/api', apiLimiter, auth);

// ── GET todos los empleados ──────────────────────────────────────────────────
app.get('/api/empleados', async (req, res) => {
  const q          = sanitizeText(req.query.q || '', 100);
  const dependencia = sanitizeText(req.query.dependencia || '', 100);

  let query = `
    SELECT id, region, dependencia, nombre_apellido, dni,
           dias_totales, dias_tomados,
           (dias_totales - dias_tomados) AS saldo_disponible
    FROM empleados WHERE 1=1
  `;
  const params = [];

  if (q) {
    params.push(`%${q.toUpperCase()}%`);
    query += ` AND (UPPER(nombre_apellido) LIKE $${params.length} OR dni LIKE $${params.length})`;
  }
  if (dependencia) {
    params.push(dependencia);
    query += ` AND dependencia = $${params.length}`;
  }
  query += ' ORDER BY dependencia, nombre_apellido';

  try {
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('Error GET /empleados:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── POST crear empleado ──────────────────────────────────────────────────────
app.post('/api/empleados', async (req, res) => {
  const nombre_apellido = sanitizeText(req.body.nombre_apellido || '', 150);
  const dni             = sanitizeText(req.body.dni || '', 20);
  const dependencia     = sanitizeText(req.body.dependencia || '', 100);
  const region          = sanitizeText(req.body.region || 'CORDOBA', 50);
  const dias_totales    = parseInt(req.body.dias_totales, 10);

  if (!nombre_apellido) return res.status(400).json({ error: 'El nombre es obligatorio' });
  if (!dni || !/^\d{1,15}$/.test(dni)) return res.status(400).json({ error: 'DNI inválido (solo dígitos, máx. 15)' });
  if (!dependencia)  return res.status(400).json({ error: 'La dependencia es obligatoria' });
  if (!Number.isFinite(dias_totales) || dias_totales <= 0 || dias_totales > 365)
    return res.status(400).json({ error: 'Días totales debe ser un número entre 1 y 365' });

  try {
    const { rows } = await pool.query(
      `INSERT INTO empleados (nombre_apellido, dni, dependencia, region, dias_totales, dias_tomados)
       VALUES ($1, $2, $3, $4, $5, 0)
       RETURNING id, region, dependencia, nombre_apellido, dni, dias_totales, dias_tomados,
                 (dias_totales - dias_tomados) AS saldo_disponible`,
      [nombre_apellido.toUpperCase(), dni, dependencia.toUpperCase(), region.toUpperCase(), dias_totales]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Ya existe un empleado con ese DNI' });
    console.error('Error POST /empleados:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── GET empleado por ID ──────────────────────────────────────────────────────
app.get('/api/empleados/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0)
    return res.status(400).json({ error: 'ID inválido' });

  try {
    const { rows } = await pool.query(
      `SELECT id, region, dependencia, nombre_apellido, dni,
              dias_totales, dias_tomados,
              (dias_totales - dias_tomados) AS saldo_disponible
       FROM empleados WHERE id = $1`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Empleado no encontrado' });
    res.json(rows[0]);
  } catch (err) {
    console.error('Error GET /empleados/:id:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── POST cargar días de vacaciones ──────────────────────────────────────────
app.post('/api/empleados/:id/vacaciones', async (req, res) => {
  const empleadoId = parseInt(req.params.id, 10);
  if (!Number.isFinite(empleadoId) || empleadoId <= 0)
    return res.status(400).json({ error: 'ID inválido' });

  const dias       = parseInt(req.body.dias, 10);
  const descripcion = sanitizeText(req.body.descripcion || '', 300);
  const fecha       = sanitizeText(req.body.fecha || '', 10);

  if (!Number.isFinite(dias) || dias <= 0 || dias > 365)
    return res.status(400).json({ error: 'La cantidad de días debe ser un número entre 1 y 365' });

  // Validar formato de fecha YYYY-MM-DD
  if (fecha && !/^\d{4}-\d{2}-\d{2}$/.test(fecha))
    return res.status(400).json({ error: 'Formato de fecha inválido' });

  const fechaFinal = fecha || new Date().toISOString().split('T')[0];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT dias_totales, dias_tomados FROM empleados WHERE id = $1 FOR UPDATE',
      [empleadoId]
    );
    if (!rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Empleado no encontrado' });
    }

    const saldo = rows[0].dias_totales - rows[0].dias_tomados;
    if (dias > saldo) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `No hay suficiente saldo. Disponible: ${saldo} días` });
    }

    await client.query(
      'UPDATE empleados SET dias_tomados = dias_tomados + $1, updated_at = NOW() WHERE id = $2',
      [dias, empleadoId]
    );
    await client.query(
      'INSERT INTO movimientos (empleado_id, dias, descripcion, fecha) VALUES ($1, $2, $3, $4)',
      [empleadoId, dias, descripcion || null, fechaFinal]
    );
    await client.query('COMMIT');

    const updated = await pool.query(
      `SELECT id, region, dependencia, nombre_apellido, dni,
              dias_totales, dias_tomados,
              (dias_totales - dias_tomados) AS saldo_disponible
       FROM empleados WHERE id = $1`,
      [empleadoId]
    );
    res.json({ message: `✅ Se cargaron ${dias} día(s) correctamente`, empleado: updated.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error POST /vacaciones:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  } finally {
    client.release();
  }
});

// ── GET historial de movimientos ─────────────────────────────────────────────
app.get('/api/empleados/:id/movimientos', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0)
    return res.status(400).json({ error: 'ID inválido' });

  try {
    const { rows } = await pool.query(
      `SELECT id, dias, descripcion, fecha, created_at
       FROM movimientos WHERE empleado_id = $1
       ORDER BY fecha DESC, created_at DESC`,
      [id]
    );
    res.json(rows);
  } catch (err) {
    console.error('Error GET /movimientos:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── GET dependencias únicas ──────────────────────────────────────────────────
app.get('/api/dependencias', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT dependencia FROM empleados
       WHERE dependencia IS NOT NULL AND dependencia != ''
       ORDER BY dependencia`
    );
    res.json(rows.map(r => r.dependencia));
  } catch (err) {
    console.error('Error GET /dependencias:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── GET grilla de vacaciones por año ─────────────────────────────────────────
// Devuelve empleados con sus movimientos del año solicitado,
// calculando fecha_fin = fecha + dias - 1
app.get('/api/grilla', async (req, res) => {
  const anio = parseInt(req.query.anio, 10);
  if (!Number.isFinite(anio) || anio < 2020 || anio > 2100)
    return res.status(400).json({ error: 'Año inválido' });

  try {
    // Todos los empleados
    const { rows: empleados } = await pool.query(
      `SELECT id, region, dependencia, nombre_apellido, dni,
              dias_totales, dias_tomados,
              (dias_totales - dias_tomados) AS saldo_disponible
       FROM empleados
       ORDER BY dependencia, nombre_apellido`
    );

    // Movimientos del año solicitado (con fecha_fin calculada)
    const { rows: movimientos } = await pool.query(
      `SELECT m.id, m.empleado_id, m.dias, m.descripcion, m.fecha,
              (m.fecha + (m.dias - 1) * INTERVAL '1 day')::date AS fecha_fin
       FROM movimientos m
       WHERE EXTRACT(YEAR FROM m.fecha) = $1
          OR EXTRACT(YEAR FROM m.fecha + (m.dias - 1) * INTERVAL '1 day') = $1
       ORDER BY m.fecha`,
      [anio]
    );

    // Agrupar movimientos por empleado_id
    const movPorEmpleado = {};
    movimientos.forEach(m => {
      if (!movPorEmpleado[m.empleado_id]) movPorEmpleado[m.empleado_id] = [];
      movPorEmpleado[m.empleado_id].push(m);
    });

    // Calcular días programados en el año para cada empleado
    const resultado = empleados.map(e => {
      const movs = movPorEmpleado[e.id] || [];
      // Días programados en el año: sumar días de movimientos del año
      const diasProgramados = movs.reduce((acc, m) => acc + m.dias, 0);
      return {
        ...e,
        movimientos: movs,
        dias_programados_anio: diasProgramados
      };
    });

    res.json(resultado);
  } catch (err) {
    console.error('Error GET /grilla:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── GET estadísticas ─────────────────────────────────────────────────────────
app.get('/api/stats', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT COUNT(*) AS total_empleados,
             SUM(dias_totales) AS total_dias_asignados,
             SUM(dias_tomados) AS total_dias_tomados,
             SUM(dias_totales - dias_tomados) AS total_saldo
      FROM empleados
    `);
    res.json(rows[0]);
  } catch (err) {
    console.error('Error GET /stats:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── DELETE empleado ──────────────────────────────────────────────────────────
app.delete('/api/empleados/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0)
    return res.status(400).json({ error: 'ID inválido' });

  try {
    const { rows } = await pool.query('SELECT nombre_apellido FROM empleados WHERE id = $1', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Empleado no encontrado' });
    await pool.query('DELETE FROM empleados WHERE id = $1', [id]);
    res.json({ message: `Empleado ${rows[0].nombre_apellido} eliminado correctamente` });
  } catch (err) {
    console.error('Error DELETE /empleados:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── DELETE movimiento (con reversión) ────────────────────────────────────────
app.delete('/api/movimientos/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0)
    return res.status(400).json({ error: 'ID inválido' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM movimientos WHERE id = $1', [id]);
    if (!rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Movimiento no encontrado' });
    }

    const mov = rows[0];
    await client.query(
      'UPDATE empleados SET dias_tomados = GREATEST(0, dias_tomados - $1), updated_at = NOW() WHERE id = $2',
      [mov.dias, mov.empleado_id]
    );
    await client.query('DELETE FROM movimientos WHERE id = $1', [id]);
    await client.query('COMMIT');
    res.json({ message: `Movimiento eliminado. Se revirtieron ${mov.dias} día(s)` });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error DELETE /movimientos:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  } finally {
    client.release();
  }
});

// ── Capturar rutas no encontradas (evitar exponer stack traces) ───────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Ruta no encontrada' });
});

// ── Manejador global de errores ───────────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error('Error no manejado:', err.message);
  res.status(500).json({ error: 'Error interno del servidor' });
});

app.listen(PORT, () => {
  console.log(`✅ Servidor corriendo en http://localhost:${PORT}`);
});