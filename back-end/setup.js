require('dotenv').config();
const fs       = require('fs');
const readline = require('readline');
const bcrypt   = require('bcryptjs');
const pool     = require('./db');

const comando = process.argv[2]; // "db" o "password"

/* ── Inicializar base de datos ── */
async function setupDB() {
  const sql = fs.readFileSync('./schema.sql', 'utf8');
  try {
    console.log(' Conectando a Neon PostgreSQL...');
    await pool.query(sql);
    console.log(' Base de datos inicializada correctamente');
    console.log(' Empleados cargados desde la planilla');
    process.exit(0);
  } catch (err) {
    console.error(' Error al inicializar la base de datos:', err.message);
    process.exit(1);
  }
}

/* ── Cambiar contraseña ── */
function cambiarPassword() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question('Nueva contraseña (mínimo 6 caracteres): ', (pass) => {
    rl.close();
    if (!pass || pass.length < 6) {
      console.error(' La contraseña debe tener al menos 6 caracteres.');
      process.exit(1);
    }
    const hash = bcrypt.hashSync(pass, 10);
    console.log('\n Hash generado. Reemplazá esta línea en tu archivo .env:\n');
    console.log(`APP_PASSWORD_HASH=${hash}\n`);
  });
}

/* ── Ayuda ── */
function mostrarAyuda() {
  console.log(`
Uso: node setup.js <comando>

Comandos:
  db          Inicializa la base de datos y carga los empleados
  password    Genera un nuevo hash de contraseña para el .env

Ejemplos:
  node setup.js db
  node setup.js password
  `);
}

/* ── Router ── */
if (comando === 'db')       setupDB();
else if (comando === 'password') cambiarPassword();
else mostrarAyuda();