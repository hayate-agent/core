# User-owned browser tooling

The runtime image includes Chromium's Debian runtime libraries (including GLib,
NSS/NSPR, GBM, GTK accessibility bridges, X11/Pango and fonts). Agents may install
npm tools and browser downloads in their persistent writable home without root.
No particular browser CLI is required. agent-browser, playwright-cli and other
user-installed tools use the same generic OS libraries.

Install project dependencies in the persistent checkout. Global npm tools use
NPM_CONFIG_PREFIX=/home/node/.local; its bin directory is on PATH and survives
restarts when home is persistent. Python tools can use python3 -m venv in home.
The image includes pip, venv and a C/C++ build toolchain for native extensions.
Record exact versions in package.json/lockfiles.
Additional OS packages require an image change and the normal reviewed build/
GitOps rollout. Do not modify /opt/hayate-agent at runtime.

The non-root acceptance script test/browser-smoke.sh installs agent-browser 0.39.2
and its browser, opens a local page and checks the title. It uses --no-sandbox
explicitly for the container smoke: a successful launch is not proof of browser
sandbox isolation. The operator chooses the container runtime, privileges, network access and
isolation boundary (for example a Kata runtime where available). Within that
boundary the agent chooses tools and launch arguments. Neither a remote browser
service nor Chromium's own sandbox is prescribed by the Harness. The image does
not globally disable Chrome sandboxing or change the cluster runtime.

User-installed CLIs are not automatically registered as model tools. The agent
can invoke them through its configured bash tool or a reviewed plugin tool.
