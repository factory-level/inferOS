import { Field, h, Section, TextInput, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { ProjectConfiguratorRpc, ProjectConfiguratorValues } from "./project-configurator-types";

// Copied from src/worker.ts (parseProjectAddress), since a configurator module may import nothing
// else; a test keeps the two in step. Shape only: the server checks the company, the workspace and
// that this person can read the Project, with their own InferOps access, when it binds.
const PROJECT_ADDRESS = /^inferops:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.[a-z0-9]+(?:-[a-z0-9]+)*\/project\/project\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.address === "string" && PROJECT_ADDRESS.test(values.address.trim());
  },

  initialValuesFromResourceUrl({ resourceUrl }) {
    return PROJECT_ADDRESS.test(resourceUrl) ? { address: resourceUrl } : {};
  },

  resourceUrl({ values, ui }) {
    return ui.resourceUrl(values.address?.trim());
  },

  render({ values, setValues }) {
    return <Section>
      <Field label="InferOps Project address"
        description="Paste the Project's inferops:// address, such as inferops://acme.operations/project/project/<id>. Your Gadgets read it with your own InferOps access.">
        <TextInput
          name="address"
          value={values.address}
          placeholder="inferops://<company>.<workspace>/project/project/<id>"
          onChange={address => setValues({ address })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<ProjectConfiguratorRpc, ProjectConfiguratorValues>;
