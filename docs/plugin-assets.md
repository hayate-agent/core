# Retired bundled browser assets

The old `Plugins/webui` frontend was removed from the Plugins project. Core no
longer pins, downloads, bundles or reports it as an installed Web frontend.
Historical `dist/optional-plugins/webui` provenance is not current software
inventory. The build removes only those generated retired frontend directories;
it does not delete operator-installed plugins, home directories or state.

The separate [WebUI project](https://github.com/hayate-agent/webui) owns the browser
dashboard. Plugins supplies `dashboard-api`, an API-only gateway. Its retained
channel name `webui` is for conversation/API compatibility, not proof that a
frontend is bundled or running.

Use the dashboard's current installation and deployment instructions. Existing
operator configurations explicitly pointing to the old generated module must be
migrated to the API-only gateway plus the separate dashboard before upgrading;
Core does not silently rewrite those configurations or substitute executable
plugins. Preserve the agent home, browser/backend conversation state and trusted
network/authentication configuration during migration.

Native self-update may install the separate dashboard package. The agent's
software notice labels this **installed package metadata**, not the version of an
independently supervised or centrally hosted running dashboard. A running-version
claim requires evidence from that dashboard's actual owner/process.
