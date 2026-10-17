# Nour Group ERP

## Windows desktop installer

Install Node.js, then run these commands from the project folder:

```powershell
npm install
npm run build
```

The standalone **Nour Group ERP** Windows installer is created in
`offline-release\Nour Group ERP Setup 1.0.0.exe`. Copy that installer to the
Windows computer, install the app, and launch **Nour Group ERP** from the Start
menu. Node.js is not required on the target computer.

With an empty `supabase-config.js`, the Windows app keeps its existing local,
offline data store. To share data with the web app, configure Supabase as
described below before building the installer.

## Installable web app for Android and computers

The web app can be installed from a secure HTTPS website on Android and desktop
browsers. Build a static web release with:

```powershell
npm run build:web
```

Upload the contents of `web-release` to a static host with HTTPS enabled. On
Android, open the website in Chrome and choose **Install app** or **Add to Home
screen**. On a desktop browser, use its **Install** action. The service worker
caches the app shell; signing in and synchronizing business data require an
internet connection.

The GitHub Pages workflow builds and deploys the ERP-only `web-release` when
changes reach the `main` branch or when run manually.

## Supabase setup

1. Apply `supabase\migrations\20261017000000_cloud_workspace.sql` in the
   Supabase SQL editor.
2. Disable email confirmation in Supabase Auth. Usernames are converted to
   internal, non-mailbox login identifiers, so email verification and email
   password recovery are not available.
3. Deploy the account-management Edge Function from the project directory with
   the Supabase CLI linked to your project:

   ```powershell
   supabase functions deploy manage-workspace-user
   ```

   Supabase's built-in `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and
   `SUPABASE_SERVICE_ROLE_KEY` function secrets are used server-side. Never put
   the service-role key in `supabase-config.js` or any web build.
4. Edit `supabase-config.js` and set the Supabase project URL and the public
   `anon` or `publishable` key. These two values are delivered to browsers; row
   level security protects workspace data. Do not put a secret/service-role key
   there.
5. Run `npm run build:web` again and deploy the resulting `web-release` files.
   Before sharing the HTTPS site, create the first administrator from a trusted
   device; the first account claims the new workspace.
   The first administrator's device uploads its current local workspace data.
   Other devices sign in with the same username and password to load the shared
   company data. Additional accounts keep their configured roles and
   permissions; accounts with passwords shorter than eight characters, or
   accounts Supabase rejects, must be recreated by the administrator.

With Supabase configured, the Windows installer also uses the cloud workspace,
so the web app and desktop app can share it. Existing offline-only installations
remain local until the installer is rebuilt with the Supabase configuration.

## Offline desktop use

The unconfigured Windows app includes its interface, fonts, scripts, and report
libraries and saves data on that computer, including during shutdown. Core
inventory, sales, and reports work offline. Sending email and online-store
synchronization need network access. The mobile barcode scanner uses the
computer's local network.

On a clean offline installation, create an administrator username and
password. The system then opens a short Arabic introduction that can be skipped
at any time. The initial workspace has no sample products, inventory,
customers, suppliers, receipts, or sales.

## Transferring inventory between locations

Open **نقل التخزين** under **المخزون**, choose **New**, and enter each product
code or barcode before setting its quantity. Select the source and destination
locations, then validate the transfer. The app rejects missing products,
non-positive or fractional quantities, identical locations, and quantities
greater than the source location's available stock. A validated transfer moves
the requested quantity between location balances without changing the
product's total stock and is recorded in the inventory movement history.

## Processing invoice returns

From **Invoices**, open an invoice's details and choose **Add to returns**.
Select the quantities the customer brought back and add
them to the **Returns** queue. The app prevents returning quantities that have
already been returned or are waiting to be processed.

For each returned item, split its quantity between **Good** and **Damaged**.
Good items are added back to their inventory location; damaged items are
recorded as a loss and do not increase stock. A damage reason is required for
damaged items. Deleting an invoice remains a separate action and removes any
unprocessed return requests for that invoice.

Returns update inventory and loss records; they do not change invoice payments
or issue a customer refund.

Invoice deletion is separate: open the invoice's details and choose
**Delete invoice** there. The invoice list and edit dialog have no delete action.
