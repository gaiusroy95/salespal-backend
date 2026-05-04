/**
 * One-time / bootstrap: set a user's role to admin in the database.
 *
 * Usage (from backend/ with .env loaded):
 *   node promote_user_to_admin.js
 *   node promote_user_to_admin.js other@email.com
 *
 * Requires DATABASE_URL. The user must already exist (e.g. registered in the app).
 */
require('dotenv').config();
const { query, close } = require('./src/config/db');

const DEFAULT_EMAIL = 'aritrarealty@gmail.com';

async function main() {
    const email = (process.argv[2] || DEFAULT_EMAIL).trim().toLowerCase();
    if (!email) {
        console.error('Usage: node promote_user_to_admin.js [email]');
        process.exit(1);
    }

    let exitCode = 0;
    try {
        const result = await query(
            `UPDATE users
             SET role = 'admin'
             WHERE lower(trim(email)) = $1
             RETURNING id, email, full_name, role`,
            [email]
        );

        if (result.rowCount === 0) {
            console.error(`No user found with email: ${email}`);
            console.error('Register this account in the app first, then run this script again.');
            exitCode = 1;
            return;
        }

        const u = result.rows[0];
        console.log('✅ User promoted to admin');
        console.log(`   id: ${u.id}`);
        console.log(`   email: ${u.email}`);
        console.log(`   name: ${u.full_name}`);
        console.log(`   role: ${u.role}`);
        console.log('');
        console.log('Have them sign out and sign in again so their JWT includes role: admin.');
    } catch (err) {
        console.error('Error:', err.message);
        exitCode = 1;
    } finally {
        await close().catch(() => {});
        process.exit(exitCode);
    }
}

main();
