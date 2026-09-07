'use strict';

const { Plugin, PluginSettingTab, Setting, Notice, normalizePath } = require('obsidian');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const DEFAULT_SETTINGS = {
  includeFolders: ['assets/templates'],
  tagProperty: 'fresh_obsidian_seed',
  includedPlugins: [],          // nothing included by default; opt in via settings checkboxes
  excludePluginData: true,
  outputName: '',               // empty => <vault>-template.zip
};

// ---------------------------------------------------------------------------
// Minimal ZIP writer (store + deflate), no external dependencies.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

class Zip {
  constructor() { this.files = []; }

  addFile(name, buf) {
    // name: forward-slash path; buf: Buffer
    this.files.push({ name: name.replace(/\\/g, '/'), buf });
  }

  toBuffer() {
    const chunks = [];
    const central = [];
    let offset = 0;

    for (const f of this.files) {
      const nameBuf = Buffer.from(f.name, 'utf8');
      const crc = crc32(f.buf);
      let method = 8;
      let data = zlib.deflateRawSync(f.buf);
      if (data.length >= f.buf.length) { method = 0; data = f.buf; } // store if no gain

      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);   // local file header signature
      local.writeUInt16LE(20, 4);           // version needed
      local.writeUInt16LE(0x0800, 6);       // flags: UTF-8 filenames
      local.writeUInt16LE(method, 8);       // compression method
      local.writeUInt16LE(0, 10);           // mod time
      local.writeUInt16LE(0x21, 12);        // mod date (valid, 1980-01-01)
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(data.length, 18); // compressed size
      local.writeUInt32LE(f.buf.length, 22);// uncompressed size
      local.writeUInt16LE(nameBuf.length, 26);
      local.writeUInt16LE(0, 28);           // extra length
      chunks.push(local, nameBuf, data);

      const cd = Buffer.alloc(46);
      cd.writeUInt32LE(0x02014b50, 0);      // central dir signature
      cd.writeUInt16LE(20, 4);              // version made by
      cd.writeUInt16LE(20, 6);              // version needed
      cd.writeUInt16LE(0x0800, 8);          // flags: UTF-8
      cd.writeUInt16LE(method, 10);
      cd.writeUInt16LE(0, 12);
      cd.writeUInt16LE(0x21, 14);
      cd.writeUInt32LE(crc, 16);
      cd.writeUInt32LE(data.length, 20);
      cd.writeUInt32LE(f.buf.length, 24);
      cd.writeUInt16LE(nameBuf.length, 28);
      cd.writeUInt16LE(0, 30);              // extra len
      cd.writeUInt16LE(0, 32);              // comment len
      cd.writeUInt16LE(0, 34);              // disk number
      cd.writeUInt16LE(0, 36);              // internal attrs
      cd.writeUInt32LE(0, 38);              // external attrs
      cd.writeUInt32LE(offset, 42);         // local header offset
      central.push(cd, nameBuf);

      offset += local.length + nameBuf.length + data.length;
    }

    const centralBuf = Buffer.concat(central);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);      // EOCD signature
    eocd.writeUInt16LE(0, 4);               // disk number
    eocd.writeUInt16LE(0, 6);               // disk with central dir
    eocd.writeUInt16LE(this.files.length, 8);
    eocd.writeUInt16LE(this.files.length, 10);
    eocd.writeUInt32LE(centralBuf.length, 12);
    eocd.writeUInt32LE(offset, 16);
    eocd.writeUInt16LE(0, 20);              // comment len

    return Buffer.concat([...chunks, centralBuf, eocd]);
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

module.exports = class VaultTemplateExporter extends Plugin {
  async onload() {
    await this.loadSettings();

    this.addRibbonIcon('download', 'Export vault template', () => this.exportTemplate());
    this.addCommand({
      id: 'export-vault-template',
      name: 'Export vault template to Downloads',
      callback: () => this.exportTemplate(),
    });
    this.addSettingTab(new ExporterSettingTab(this.app, this));
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // --- export ---------------------------------------------------------------

  async exportTemplate() {
    try {
      new Notice('Building vault template…');
      const zip = await this.buildZip();
      const buf = zip.toBuffer();

      let outDir = path.join(os.homedir(), 'Downloads');
      try { if (!fs.existsSync(outDir)) outDir = os.homedir(); } catch (e) { outDir = os.homedir(); }

      const vaultName = this.app.vault.getName();
      const name = (this.settings.outputName || `${vaultName}-template.zip`).trim();
      const outPath = path.join(outDir, name.endsWith('.zip') ? name : `${name}.zip`);

      fs.writeFileSync(outPath, buf);
      new Notice(`Exported ${zip.files.length} files → ${outPath}`, 8000);
    } catch (err) {
      console.error('[vault-template-exporter]', err);
      new Notice(`Export failed: ${err.message}`, 10000);
    }
  }

  async buildZip() {
    const app = this.app;
    const adapter = app.vault.adapter;
    const cfg = app.vault.configDir; // ".obsidian"
    const zip = new Zip();
    const added = new Set();

    const addPath = async (p) => {
      p = normalizePath(p);
      if (added.has(p)) return;
      if (!(await adapter.exists(p))) return;
      const st = await adapter.stat(p);
      if (!st || st.type !== 'file') return;
      const buf = Buffer.from(await adapter.readBinary(p));
      zip.addFile(p, buf);
      added.add(p);
    };

    const listRecursive = async (dir) => {
      const out = [];
      const walk = async (d) => {
        if (!(await adapter.exists(d))) return;
        const res = await adapter.list(d);
        for (const f of res.files) out.push(f);
        for (const sub of res.folders) await walk(sub);
      };
      await walk(normalizePath(dir));
      return out;
    };

    // 1) whitelisted folders (wholesale)
    for (const raw of this.settings.includeFolders) {
      const folder = (raw || '').trim().replace(/^\/+|\/+$/g, '');
      if (!folder) continue;
      for (const f of await listRecursive(folder)) await addPath(f);
    }

    // 2) individual notes tagged with the include property
    const tagProp = (this.settings.tagProperty || '').trim();
    if (tagProp) {
      for (const file of app.vault.getMarkdownFiles()) {
        const fm = app.metadataCache.getFileCache(file)?.frontmatter;
        if (fm && fm[tagProp] === true) await addPath(file.path);
      }
    }

    // 3) .obsidian config — settings only, no machine state
    const rootConfig = [
      'app.json', 'appearance.json', 'hotkeys.json', 'core-plugins.json',
      'core-plugins-migration.json', 'templates.json', 'daily-notes.json',
      'types.json', 'canvas.json',
    ];
    for (const name of rootConfig) await addPath(`${cfg}/${name}`);

    // snippets + themes wholesale
    for (const sub of ['snippets', 'themes']) {
      for (const f of await listRecursive(`${cfg}/${sub}`)) await addPath(f);
    }

    // 4) whitelisted plugins (code only; data.json optionally stripped)
    const whitelist = this.settings.includedPlugins || [];
    for (const id of whitelist) {
      const pdir = `${cfg}/plugins/${id}`;
      for (const f of await listRecursive(pdir)) {
        if (this.settings.excludePluginData && /\/data\.json$/.test(f)) continue;
        await addPath(f);
      }
    }

    // regenerate community-plugins.json to match the whitelist
    const cpPath = normalizePath(`${cfg}/community-plugins.json`);
    zip.addFile(cpPath, Buffer.from(JSON.stringify(whitelist, null, 2), 'utf8'));
    added.add(cpPath);

    return zip;
  }
};

// ---------------------------------------------------------------------------
// Settings tab
// ---------------------------------------------------------------------------

class ExporterSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Vault Template Exporter' });

    // --- include folders ---
    containerEl.createEl('h3', { text: 'Include folders' });
    containerEl.createEl('p', {
      text: 'Whole directories copied into the template (all files within).',
      cls: 'setting-item-description',
    });

    this.plugin.settings.includeFolders.forEach((folder, i) => {
      new Setting(containerEl)
        .addText((t) =>
          t
            .setPlaceholder('e.g. assets/templates')
            .setValue(folder)
            .onChange(async (v) => {
              this.plugin.settings.includeFolders[i] = v;
              await this.plugin.saveSettings();
            }))
        .addExtraButton((b) =>
          b.setIcon('trash').setTooltip('Remove').onClick(async () => {
            this.plugin.settings.includeFolders.splice(i, 1);
            await this.plugin.saveSettings();
            this.display();
          }));
    });

    new Setting(containerEl).addButton((b) =>
      b.setButtonText('Add folder').setCta().onClick(async () => {
        this.plugin.settings.includeFolders.push('');
        await this.plugin.saveSettings();
        this.display();
      }));

    // --- tagged files ---
    containerEl.createEl('h3', { text: 'Tagged notes' });
    new Setting(containerEl)
      .setName('Include property')
      .setDesc('Any note whose frontmatter has this property set to true is included.')
      .addText((t) =>
        t
          .setPlaceholder('fresh_obsidian_seed')
          .setValue(this.plugin.settings.tagProperty)
          .onChange(async (v) => {
            this.plugin.settings.tagProperty = v;
            await this.plugin.saveSettings();
          }));

    // --- output ---
    containerEl.createEl('h3', { text: 'Output' });
    new Setting(containerEl)
      .setName('Zip file name')
      .setDesc('Saved to your Downloads folder. Leave blank for "<vault>-template.zip".')
      .addText((t) =>
        t
          .setPlaceholder('<vault>-template.zip')
          .setValue(this.plugin.settings.outputName)
          .onChange(async (v) => {
            this.plugin.settings.outputName = v;
            await this.plugin.saveSettings();
          }));

    new Setting(containerEl)
      .setName('Exclude plugin data.json')
      .setDesc('Strip every plugin data.json (may contain personal data). Recommended.')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.excludePluginData).onChange(async (v) => {
          this.plugin.settings.excludePluginData = v;
          await this.plugin.saveSettings();
        }));

    // --- plugin whitelist ---
    containerEl.createEl('h3', { text: 'Plugins to include' });
    containerEl.createEl('p', {
      text: 'Only checked community plugins are shipped (code only). Uncheck anything personal or that auto-uploads.',
      cls: 'setting-item-description',
    });

    const manifests = Object.values(this.app.plugins.manifests)
      .filter((m) => m.id !== this.plugin.manifest.id)
      .sort((a, b) => a.name.localeCompare(b.name));

    const enabled = this.app.plugins.enabledPlugins;
    const included = new Set(this.plugin.settings.includedPlugins || []);

    for (const m of manifests) {
      new Setting(containerEl)
        .setName(m.name)
        .setDesc(`${m.id}${enabled.has(m.id) ? '' : ' (currently disabled)'}`)
        .addToggle((t) =>
          t.setValue(included.has(m.id)).onChange(async (v) => {
            if (v) included.add(m.id); else included.delete(m.id);
            this.plugin.settings.includedPlugins = Array.from(included).sort();
            await this.plugin.saveSettings();
          }));
    }
  }
}
