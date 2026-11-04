import { createFileRoute } from "@tanstack/react-router";
import {
  C,
  Callout,
  Code,
  Diagram,
  DocLink,
  DocsHeader,
  H2,
  H3,
  NextPrev,
  P,
  Steps,
  Table,
  UL,
} from "@/components/docs/DocsShell";

export const Route = createFileRoute("/docs/keys")({
  head: () => ({
    meta: [
      { title: "Keys & encryption — AgentSwarms Documentation" },
      {
        name: "description",
        content:
          "What the platform encrypts with no setup, the one secret to keep, and when an external KMS or customer keys are worth it, explained from the beginning.",
      },
      { property: "og:title", content: "Keys & encryption — AgentSwarms Documentation" },
      {
        property: "og:description",
        content: "Encryption keys from the beginning: nothing to set up, one secret to keep.",
      },
      { property: "og:url", content: "https://agentswarms.fyi/docs/keys" },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [{ rel: "canonical", href: "https://agentswarms.fyi/docs/keys" }],
  }),
  component: KeysPage,
});

function KeysPage() {
  return (
    <>
      <DocsHeader
        eyebrow="Govern & operate"
        title="Keys & encryption"
        description="What is encrypted with no setup at all, the one secret you must keep, and when an external key service or customer keys are worth it. Written for someone who has never had to think about encryption keys."
      />

      <Callout kind="info" title="You do not need to set up anything here">
        The installer makes the one key a deployment needs, and every feature works with it. An
        external key service (KMS) and customer keys are optional: nothing is turned off without
        them, and nothing asks for them.
      </Callout>

      <H2 id="start">Start here</H2>
      <P>
        A fresh install already encrypts what this page describes. The setup script generates{" "}
        <C>PROVIDER_CREDS_SECRET</C>, 32 random bytes, and the app derives the{" "}
        <strong>deployment key</strong> from it. With nothing else configured:
      </P>
      <UL>
        <li>
          every credential a user saves is encrypted before it reaches the database, under a key of
          that user&apos;s own, which the app makes at their first save and locks with the
          deployment key;
        </li>
        <li>
          the documents chat generates, the copies of uploaded datasets, and what agents remember
          about each user are encrypted the same way before they are stored;
        </li>
        <li>
          nothing waits on a key service: no extra container, no network call, nothing to pay for.
        </li>
      </UL>
      <P>
        A user who is under no customer key never meets one. Saving a credential, querying the
        lakehouse, running a notebook, a pipeline or a training run, and chatting work the same for
        them whether or not the deployment has customer keys for other people. While lakehouse files
        are not under customer keys, which is the default for the bundled object store, opening the
        lakehouse does no key work at all.
      </P>

      <H3 id="protected">What is protected, with no setup</H3>
      <Table
        headers={["What", "Where it is kept", "What protects it"]}
        rows={[
          [
            "Credentials: model provider keys, warehouse and SaaS connections, secrets, integrations, MCP servers, catalog and knowledge-base sources, Git export, Slack and Teams bots, embed keys",
            "The database",
            "Encrypted by the app (AES-256-GCM) under the user's own key, which the deployment key locks",
          ],
          [
            "Documents chat generates; copies of uploaded datasets",
            "File storage",
            "Encrypted by the app under the owner's user key",
          ],
          [
            "Lakehouse tables, model artifacts, rows a run stages",
            "The object store",
            "The store's own encryption: AWS S3 and Cloud Storage encrypt every object; the bundled SILO and MinIO write files as they are unless their encryption is configured or their disk is encrypted",
          ],
          [
            "What agents remember about each user: long-term memory, conversation summaries, scratchpads",
            "The database",
            "Encrypted by the app under the user's own key; recall finds an item by keyed hashes of its words, never the words",
          ],
          [
            "Agent Chat history: every message, its citations and sources, a generated document's name and thumbnail, and every conversation's title",
            "The database",
            "Encrypted by the app under the user's own key; a generated document's storage path stays readable",
          ],
          [
            "Swarm chats (transcript, flow state, title) and AI Analyst threads (questions, SQL, write-ups, samples of result rows, title)",
            "The database",
            "Encrypted by the app under the user's own key",
          ],
          [
            "Model call traces (the prompt, messages, tool calls and reply)",
            "The database",
            "Encrypted by the app under the user's own key",
          ],
          [
            "Swarm run traces, knowledge-base text, notebooks, datasets' rows",
            "The database",
            "The database's own encryption at rest: a managed Postgres encrypts its disks; one you run yourself is as safe as its disk",
          ],
        ]}
      />
      <P>
        Passwords are not on the list because the app never stores them: sign-in keeps only a hash,
        or your identity provider signs users in.
      </P>

      <H3 id="keep-the-secret">The one thing you must do: keep the deployment secret</H3>
      <P>
        Every user key is locked by the deployment key, and the deployment key is made from{" "}
        <C>PROVIDER_CREDS_SECRET</C>.{" "}
        <strong>Lose it and every stored credential and generated document is unreadable</strong>,
        with no way back: no copy exists anywhere else, by design.
      </P>
      <Steps
        items={[
          {
            title: "Copy it somewhere safe",
            body: (
              <>
                From <C>.env</C> (on Kubernetes, the <C>agentswarms-bootstrap</C> Secret) into a
                password manager or secret manager, kept apart from your database backups.{" "}
                <C>npm run backup</C> names it and says it cannot contain it.
              </>
            ),
          },
          {
            title: "Keep it out of chat, tickets and git",
            body: "Anyone who holds it and a copy of the database can read every credential.",
          },
          {
            title: "Bring the same value when you move",
            body: "A rebuilt or moved server needs the same secret. A different value makes a different key, and nothing stored under the old one opens.",
          },
        ]}
      />
      <Callout kind="warn" title="If it is lost anyway">
        Put a new value in <C>PROVIDER_CREDS_SECRET</C> and restart. A save for a user whose key the
        old secret locked is then refused, with a message that says why and what to do, until an
        admin erases that user&apos;s key (
        <strong>Admin → IAM → Settings → Customer keys → Erase a user&apos;s key</strong>). Each
        one&apos;s next save makes a new key, and they enter their credentials again. Users who had
        saved nothing are not affected.
      </Callout>

      <H2 id="plain-words">Keys in plain words</H2>

      <H3 id="at-rest">What encryption at rest is for, and what it is not</H3>
      <P>
        Encryption at rest means data is stored scrambled, so that someone who gets a copy of the
        storage (a stolen backup, a database dump, the disk of a retired server, a bucket left open
        by mistake) sees noise instead of your passwords. Unscrambling it takes the{" "}
        <strong>key</strong>, a random number 256 bits long: far too many possibilities to guess.
      </P>
      <P>
        It does <strong>not</strong> protect against someone who can use the running app. The app
        has to unscramble a credential to use it, so whoever takes over the server process, or signs
        in as a user, sees what that process or user can see. That is the job of sign-in and{" "}
        <DocLink to="/docs/iam">access control</DocLink>. The two are locks on different doors, and
        you want both.
      </P>

      <H3 id="envelope">Envelope encryption: a key that locks other keys</H3>
      <P>
        Encrypting everything directly with one master key makes every change hard: replacing it
        means rewriting everything, and it has to be at hand for every read. So nearly every serious
        system uses <strong>envelope encryption</strong>: the data is encrypted with a{" "}
        <strong>data key</strong>, and the data key is stored next to it, itself encrypted (
        <strong>wrapped</strong>) by a <strong>key-encrypting key</strong>. To read, the app unwraps
        the data key once and then uses it as often as it needs.
      </P>
      <Callout kind="why" title="A picture">
        Your valuables are in a box locked with a small key. The small key is kept in a lockbox that
        only the bank can open. When the bank changes its lockbox, nobody repacks the boxes: the
        small keys move to the new lockbox. And if the bank refuses to open the lockbox, every box
        behind it stays shut, at once.
      </Callout>

      <H3 id="layers">The layers here</H3>
      <Diagram caption="Who locks what. A customer key, if you make one, locks its members' user keys instead of the deployment key.">{`   PROVIDER_CREDS_SECRET  ──or──  a key in your KMS (KMS_PROVIDER)
              │
              ▼
        deployment key           one per deployment, made at install
              │ locks
              ▼
          user keys              one per user, made at their first save
              │ encrypt          (a customer key can lock them instead)
              ▼
   that user's credentials, secrets and connections,
   the documents chat made for them, their dataset copies,
   what agents remember about them, their chats and analyses`}</Diagram>
      <UL>
        <li>
          The <strong>deployment key</strong> is the root: derived from <C>PROVIDER_CREDS_SECRET</C>{" "}
          by default, or a random data key only your KMS can unwrap.
        </li>
        <li>
          Each <strong>user key</strong> belongs to one person, so one person&apos;s data can be
          made unreadable without touching anyone else&apos;s.
        </li>
        <li>
          A <strong>customer key</strong> sits between the two for the users and groups assigned to
          it.
        </li>
        <li>
          <strong>Lakehouse files</strong> are the object store&apos;s to encrypt: with its own keys
          by default, or with a customer&apos;s key when that key is in a KMS the store can use.
        </li>
      </UL>

      <H3 id="kms">What a key management service (KMS) adds</H3>
      <P>
        A <strong>KMS</strong> keeps a key inside itself and does the wrapping and unwrapping, so
        the key never leaves it: AWS KMS, Azure Key Vault, Google Cloud KMS, OCI Vault, or HashiCorp
        Vault, which you can run yourself. Compared with a secret in an environment variable, it
        gives you a record of every use, a permission to unwrap instead of the key itself (so
        reading the server&apos;s environment does not give the key away), one switch that stops
        every deployment using the key, and hardware backing (an HSM) if you want it.
      </P>
      <P>
        What it costs is one more service to keep available. The app unwraps its data key once when
        it starts, never per request, so a KMS that is slow or briefly down while the app runs
        changes nothing. A KMS that cannot be reached <strong>when the app starts</strong> keeps it
        from starting, on purpose, rather than let it run without its key.
      </P>

      <H3 id="customer-keys">What a customer key adds (BYOK for encryption)</H3>
      <P>
        A customer key is for a deployment that serves more than one organisation. Say an agency
        runs the platform for three clients, each client&apos;s people in an IAM group. Give each
        client a customer key and assign their group to it; their users&apos; keys are then locked
        by their client&apos;s key. The key is either <strong>held by the app</strong> (a separate
        key per client, which you hold) or <strong>in the customer&apos;s own KMS</strong>: the
        client creates it in their own cloud account, grants the app permission to use it, and can
        take the permission away at any time. That second kind is what enterprises usually mean by{" "}
        <strong>bring your own key</strong> (BYOK).
      </P>
      <Callout kind="info" title="Two different BYOKs">
        Elsewhere in these docs, BYOK means bringing your own <em>model provider</em> API key, so
        that model calls are billed to and governed by your own account (
        <DocLink to="/docs/concepts" hash="byok">
          Core concepts
        </DocLink>
        ). That has nothing to do with encryption keys, and neither needs the other.
      </Callout>

      <H3 id="words">Rotate, erase, destroy, revoke</H3>
      <Table
        headers={["Word", "What it means", "What happens to the data"]}
        rows={[
          [
            "Rotate",
            "Replace a key, keeping the old one readable until everything has moved",
            "Nothing is lost: a sweep moves everything onto the new key",
          ],
          [
            "Erase (a user's key)",
            "Delete one user's key",
            "What that user stored becomes unreadable; their next save makes a new key",
          ],
          [
            "Destroy (a customer key)",
            "Delete a customer key in the app",
            "Every user key it locked is erased with it",
          ],
          [
            "Revoke",
            "The customer disables their KMS key or removes the app's permission",
            "Their members' data does not read until it is turned back on; a key deleted in their KMS makes it permanent, backups included",
          ],
        ]}
      />

      <H2 id="which">Which setup is right for you</H2>
      <Table
        headers={["You are", "Use", "Start with"]}
        rows={[
          [
            "Trying it out, on your own, or a small team on one server",
            "The default",
            <DocLink key="d" to="/docs/keys" hash="keep-the-secret">
              Keep the deployment secret
            </DocLink>,
          ],
          [
            "A company whose policy requires keys in a KMS or an HSM, or audit of key use",
            "An external KMS for the deployment key",
            <DocLink key="k" to="/docs/keys" hash="tutorial-kms">
              Move the key into a KMS
            </DocLink>,
          ],
          [
            "Hosting several organisations, one of which wants control of its own key",
            "Customer keys",
            <DocLink key="c" to="/docs/keys" hash="tutorial-customer">
              Give a customer their own key
            </DocLink>,
          ],
          [
            "Required to make one person's data unreadable on request",
            "User keys, already on",
            <DocLink key="e" to="/docs/keys" hash="tutorial-erase">
              Take data out of reach
            </DocLink>,
          ],
        ]}
      />
      <P>
        They combine: a deployment key in AWS KMS, two customers with keys in their own accounts,
        and everyone else under the deployment key.
      </P>

      <H2 id="tutorials">Tutorials</H2>

      <H3 id="tutorial-check">Check what protects your deployment</H3>
      <Steps
        items={[
          {
            title: "Open the settings",
            body: (
              <>
                As a superadmin, open <strong>Admin → IAM → Settings</strong>.
              </>
            ),
          },
          {
            title: "Read the credential key card",
            body: (
              <>
                With no setup, <strong>Credential encryption key</strong> shows Key provider
                &ldquo;env (PROVIDER_CREDS_SECRET)&rdquo; and &ldquo;keyring loaded&rdquo;: the
                deployment key works. It also shows the key&apos;s fingerprint and how many stored
                values are on which key.
              </>
            ),
          },
          {
            title: "Read the customer keys card",
            body: (
              <>
                &ldquo;No customer keys yet. Every user key is wrapped by the deployment&apos;s
                key.&rdquo; is the normal state for most deployments. If it says a migration is
                needed instead, apply it with <C>npx supabase db push</C>; until then everything is
                under the deployment key, and nothing is wrong.
              </>
            ),
          },
        ]}
      />

      <H3 id="tutorial-backup">Back up the deployment secret, and prove the backup</H3>
      <Code lang="bash">{`# On Kubernetes, the secret is in its Secret:
kubectl -n agentswarms get secret agentswarms-bootstrap -o jsonpath='{.data.PROVIDER_CREDS_SECRET}' | base64 -d

# The backup names it, and says it cannot contain it:
npm run backup`}</Code>
      <P>
        Keep the value and the backup in different places: whoever has both has every credential. To
        prove the copy, restore into a scratch install with the saved value in its <C>.env</C> and
        compare the fingerprint on <strong>Admin → IAM → Settings</strong> with your live
        deployment&apos;s. The same fingerprint is the same key.
      </P>

      <H3 id="tutorial-rotate">Rotate the deployment secret</H3>
      <P>
        Rotate when the secret may have leaked (it was pasted somewhere, someone who had it left),
        or when your policy rotates keys on a schedule. Nothing is unreadable at any point.
      </P>
      <Steps
        items={[
          {
            title: "Make a new value",
            body: <C>openssl rand -hex 32</C>,
          },
          {
            title: "Keep the old one readable",
            body: (
              <>
                In <C>.env</C>, move the current value to <C>PROVIDER_CREDS_SECRET_OLD</C> and put
                the new one in <C>PROVIDER_CREDS_SECRET</C>.
              </>
            ),
          },
          {
            title: "Restart",
            body: (
              <>
                <C>docker compose up -d agentswarms</C> re-reads <C>.env</C>; on Kubernetes, update
                the Secret and restart the deployment. Both keys read now.
              </>
            ),
          },
          {
            title: "Run the sweep",
            body: (
              <>
                <strong>Admin → IAM → Settings → Re-encrypt to current key</strong> re-locks every
                user key with the new key. What users stored is not rewritten.
              </>
            ),
          },
          {
            title: "Retire the old value",
            body: (
              <>
                When the card counts nothing left on the old key, remove{" "}
                <C>PROVIDER_CREDS_SECRET_OLD</C>, restart, and replace your saved copy.
              </>
            ),
          },
        ]}
      />

      <H3 id="tutorial-kms">Move the deployment key into a KMS</H3>
      <Steps
        items={[
          {
            title: "Create a key and grant the app its use",
            body: (
              <>
                The permissions and identity for each provider are on the{" "}
                <DocLink to="/docs/self-hosting/configuration" hash="recipe-regulated">
                  configuration page
                </DocLink>
                .
              </>
            ),
          },
          {
            title: "Point the app at it, without switching yet",
            body: (
              <>
                Set <C>KMS_KEY_REF</C> and the provider&apos;s variables, leave <C>KMS_PROVIDER</C>{" "}
                unset, restart. The credential key card shows the provider and whether the app can
                reach it.
              </>
            ),
          },
          {
            title: "Create the data key there",
            body: "The app makes it, has the KMS wrap it, proves it unwraps, and only then stores it. Nothing else changes yet.",
          },
          {
            title: "Switch",
            body: (
              <>
                Set <C>KMS_PROVIDER</C> to the provider and restart. Everything new uses the data
                key; <C>PROVIDER_CREDS_SECRET</C> still reads what it wrote.
              </>
            ),
          },
          {
            title: "Move what is left",
            body: (
              <>
                Run <strong>Re-encrypt to current key</strong>. When nothing is left on the env key,{" "}
                <C>PROVIDER_CREDS_SECRET</C> can go.
              </>
            ),
          },
        ]}
      />

      <H3 id="tutorial-customer">Give a customer their own key</H3>
      <P>
        Say Acme&apos;s people are in the IAM group <C>acme-staff</C>, and Acme wants their data
        under a key in their own AWS account.
      </P>
      <Steps
        items={[
          {
            title: "Acme creates the key and grants your app its use",
            body: (
              <>
                A symmetric key in their AWS KMS, with a key policy statement allowing your
                app&apos;s role <C>kms:GenerateDataKey</C>, <C>kms:Decrypt</C> and{" "}
                <C>kms:DescribeKey</C>. They send you its ARN. (Azure Key Vault, Cloud KMS, OCI
                Vault and Vault Transit work the same way, each with its own permission.)
              </>
            ),
          },
          {
            title: "Create it in the app",
            body: (
              <>
                <strong>Admin → IAM → Settings → Customer keys</strong>: under New customer key,
                name it, choose <strong>In the customer&apos;s KMS</strong>, paste the ARN, and
                press <strong>Create customer key</strong>. A missing permission shows now, not
                later.
              </>
            ),
          },
          {
            title: "Check it",
            body: (
              <>
                <strong>Check</strong> unwraps again and shows what the KMS says about the key; when
                the lakehouse store can use the key, it also writes, reads and deletes a test file
                under it.
              </>
            ),
          },
          {
            title: "Assign the group",
            body: (
              <>
                Choose <C>acme-staff</C> in <strong>Assign a group or a user…</strong> and press{" "}
                <strong>Assign</strong>. Every member&apos;s user key is locked by Acme&apos;s key
                at once; their lakehouse files follow in the background when the store can use it.
              </>
            ),
          },
        ]}
      />
      <P>
        Nothing changes for Acme&apos;s people or for anyone else: they sign in, save and query as
        before. If Acme later disables the key, their saved credentials and documents stop working
        with an error that names Acme&apos;s key, and nobody else is affected; when Acme turns it
        back on, everything works again. Without a KMS, choose <strong>Held by the app</strong>: a
        separate key per customer, which you hold.
      </P>

      <H3 id="tutorial-erase">Take data out of reach</H3>
      <UL>
        <li>
          <strong>One person</strong>: <strong>Erase a user&apos;s key</strong> on the Customer keys
          card, then <strong>Erase the key</strong>. Their credentials, connections, secrets,
          generated documents, dataset copies, what agents remember about them and their chats and
          analyses are unreadable at once here, and in every server process within{" "}
          <C>DATA_KEY_CACHE_SECONDS</C> (five minutes by default). Deleting their account does the
          same.
        </li>
        <li>
          <strong>One customer</strong>: <strong>Destroy</strong> on their customer key, typing its
          name. Every user key it locked is erased with it.
        </li>
        <li>
          <strong>For good, backups included</strong>: a key erased in the app is still in backups
          taken before. Only a customer key in the customer&apos;s own KMS, deleted in that KMS,
          makes those unreadable too.
        </li>
      </UL>
      <P>
        What a swarm run&apos;s steps keep, and the notifications a scheduled analysis leaves, are
        not under these keys yet: delete the account for those.
      </P>

      <H2 id="mistakes">Mistakes, and what you see</H2>
      <Table
        headers={["You did", "You see", "The fix"]}
        rows={[
          [
            "Lost PROVIDER_CREDS_SECRET, or pointed a new install with a new secret at the old database",
            "Stored credentials do not read; saves for those users are refused, naming a deployment key this server does not hold",
            "Put the old value back; if it is gone for good, erase the affected users' keys",
          ],
          [
            "Removed PROVIDER_CREDS_SECRET_OLD before running the sweep",
            "The same",
            "Put it back, run Re-encrypt to current key, then remove it",
          ],
          [
            "Set KMS_PROVIDER before creating the data key, or the app lost its KMS permission",
            "The app does not start; its log names the provider, the key and the error",
            "Unset KMS_PROVIDER and create the data key first, or restore the permission",
          ],
          [
            "Put a user in two groups assigned to different customer keys",
            "Their saves are refused, naming both keys and groups",
            "Assign the user directly to one key",
          ],
          [
            "Assigned a key in one cloud's KMS while the lakehouse is in another cloud's store",
            "The key's card says the store cannot use it for files",
            "Credentials are covered either way; for files, use a key in the store's own cloud",
          ],
        ]}
      />

      <H2 id="reference">Where the details are</H2>
      <UL>
        <li>
          Every variable, each provider&apos;s identity and permissions, and private paths to a KMS:{" "}
          <DocLink to="/docs/self-hosting/configuration" hash="recipe-regulated">
            Configuration
          </DocLink>
          .
        </li>
        <li>
          How stored secrets are referenced and shared:{" "}
          <DocLink to="/docs/secrets">Secrets</DocLink>.
        </li>
        <li>
          Lakehouse files under a customer&apos;s key, on S3 and Cloud Storage:{" "}
          <DocLink to="/docs/lakehouse" hash="customer-keys">
            Lakehouse
          </DocLink>
          .
        </li>
        <li>
          The full reference, with every failure mode and the design record:{" "}
          <C>docs/KEY_MANAGEMENT.md</C> in the repository.
        </li>
      </UL>

      <NextPrev current="/docs/keys" />
    </>
  );
}
