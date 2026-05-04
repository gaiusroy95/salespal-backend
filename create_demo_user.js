/**
 * Creates a demo user for Razorpay verification.
 * Run once: node create_demo_user.js
 */
const bcrypt = require('bcrypt');
const db = require('./src/config/db');

async function createDemoUser() {
    const email = 'demo@salespal.ai';
    const password = 'Demo@1234';
    const fullName = 'Demo User';

    try {
        // Check if already exists
        const { rows: existing } = await db.query(
            'SELECT id FROM users WHERE email = $1', [email]
        );

        if (existing.length > 0) {
            console.log(`✅ Demo user already exists: ${email}`);
            
            const userId = existing[0].id;
            const { rows: existingOrg } = await db.query(
                'SELECT org_id FROM org_members WHERE user_id = $1', [userId]
            );
            
            if (existingOrg.length === 0) {
                console.log('⚠️ Demo user is missing an organization. Fixing...');
                await db.query('BEGIN');
                try {
                    const orgResult = await db.query(
                      `INSERT INTO organizations (name, slug)
                       VALUES ($1, $2) RETURNING id`,
                      [`${fullName}'s Workspace`, email.split('@')[0]]
                    );
                    
                    await db.query(
                      `INSERT INTO org_members (user_id, org_id, role)
                       VALUES ($1, $2, 'owner')`,
                      [userId, orgResult.rows[0].id]
                    );
                    await db.query('COMMIT');
                    console.log('✅ Demo user organization created successfully!');
                } catch (e) {
                    await db.query('ROLLBACK');
                    throw e;
                }
            }
            process.exit(0);
        }

        const passwordHash = await bcrypt.hash(password, 12);

        await db.query('BEGIN');
        const { rows } = await db.query(
            `INSERT INTO users (email, password_hash, full_name, email_verified, role)
             VALUES ($1, $2, $3, true, 'user')
             RETURNING id, email, full_name`,
            [email, passwordHash, fullName]
        );
        
        const orgResult = await db.query(
          `INSERT INTO organizations (name, slug)
           VALUES ($1, $2) RETURNING id`,
          [`${fullName}'s Workspace`, email.split('@')[0]]
        );
        
        await db.query(
          `INSERT INTO org_members (user_id, org_id, role)
           VALUES ($1, $2, 'owner')`,
          [rows[0].id, orgResult.rows[0].id]
        );
        await db.query('COMMIT');

        console.log('✅ Demo user created successfully!');
        console.log('─────────────────────────────');
        console.log(`Email    : ${email}`);
        console.log(`Password : ${password}`);
        console.log(`Name     : ${fullName}`);
        console.log(`ID       : ${rows[0].id}`);
        console.log('─────────────────────────────');
    } catch (err) {
        console.error('❌ Error:', err.message);
    } finally {
        process.exit(0);
    }
}

createDemoUser();
