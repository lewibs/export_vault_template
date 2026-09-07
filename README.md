# Export Vault Template

An Obsidian plugin that exports a clean **starter-vault template** as a zip into
your Downloads folder — so you (or anyone) can spin up a fresh vault in your
preferred layout, with **no personal data**.

## What it exports

- **Whitelisted folders** — whole directories you choose (e.g. `assets/templates`).
- **Tagged notes** — any note whose frontmatter has your include property set to
  `true` (default `fresh_obsidian_seed`).
- **Selected plugins** — a checkbox list of every installed plugin; only the ones
  you check are shipped (code only). Each plugin's `data.json` is stripped by
  default so no personal state or secrets leak.
- **`.obsidian` config** — app settings, appearance, hotkeys, templates config,
  snippets, and themes. Machine state (workspace layout, graph) is excluded.

The shipped `community-plugins.json` is regenerated to match your whitelist, so a
fresh vault enables exactly the plugins you picked — nothing dangling.

## Usage

1. Reload Obsidian after installing (Command palette → *Reload app without saving*).
2. Configure in **Settings → Vault Template Exporter**:
   - Add **include folders**.
   - Set the **include property** (default `fresh_obsidian_seed`).
   - Check the **plugins** you want shipped (nothing is checked by default).
3. Click the **download ribbon icon**, or run the command
   **“Export vault template to Downloads.”**
4. The zip lands in `~/Downloads` as `<vault>-template.zip`.

To use the template: unzip into a new empty folder and open it as a vault.

## Install (manual)

Copy `main.js` and `manifest.json` into
`<your-vault>/.obsidian/plugins/vault-template-exporter/`, then enable the plugin
in **Settings → Community plugins**.

## Notes

- Desktop only — uses Node (`fs`, `zlib`) to build the zip. No external
  dependencies; the zip writer is built in.
- Nothing is uploaded anywhere; the plugin only writes a local zip file.
