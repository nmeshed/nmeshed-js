#!/usr/bin/env node
import cac from 'cac';
import { version } from '../package.json';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

const cli = cac('nmeshed');

cli
    .command('deploy', 'Deploy the nMeshed Cloudflare Worker')
    .option('--name <name>', 'Name of the worker', { default: 'nmeshed-worker' })
    .action(async (options) => {
        console.log(`🚀 Deploying nMeshed Worker: ${options.name}...`);

        // 1. Check for Wrangler
        try {
            await runCommand('wrangler', ['--version']);
        } catch (e) {
            console.error('❌ Error: "wrangler" not found. Please install it: npm install -g wrangler');
            process.exit(1);
        }

        // 2. Check for login
        // In a real implementation, we'd check `wrangler whoami` output.
        console.log('✅ Wrangler found.');

        // 3. Generate wrangler.toml if missing
        const wranglerPath = path.join(process.cwd(), 'wrangler.toml');
        if (!fs.existsSync(wranglerPath)) {
            console.log('ℹ️  No wrangler.toml found. Generating default...');
            const template = `
name = "${options.name}"
main = "src/index.js"
compatibility_date = "2024-04-01"

[[durable_objects.bindings]]
name = "NMESHED_DO"
class_name = "NMeshedDO"

[[migrations]]
tag = "v1"
new_classes = ["NMeshedDO"]

[[d1_databases]]
binding = "DB"
database_name = "nmeshed-db"
database_id = "REPLACE_WITH_YOUR_D1_ID"

[[r2_buckets]]
binding = "SNAPSHOTS"
bucket_name = "nmeshed-snapshots"
`;
            fs.writeFileSync(wranglerPath, template);
            console.log('⚠️  Created wrangler.toml. Please update "database_id" with your D1 Database ID.');
            console.log('   Run: npx wrangler d1 create nmeshed-db');
            return;
        }

        // 4. Deploy (Simulation for now as we don't have the bundled WASM here yet in this SDK package)
        console.log('📦 Bundled Worker not found in SDK (Dev Mode).');
        console.log('   In production, this would `wrangler deploy` the pre-packaged WASM.');

        // In a real scenario, we would:
        // 1. Copy `node_modules/nmeshed/dist/worker/*` to a temp dir.
        // 2. Run `wrangler deploy` in that temp dir.
    });

cli.help();
cli.version(version);
cli.parse();

function runCommand(command: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: 'inherit', shell: true });
        child.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`Command failed with code ${code}`));
        });
        child.on('error', reject);
    });
}
