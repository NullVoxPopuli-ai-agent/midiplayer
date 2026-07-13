import { click, render } from "@ember/test-helpers";
import { module, test } from "qunit";
import { setupRenderingTest } from "ember-qunit";

import { PortalTargets } from "ember-primitives";

import { FileMenu } from "#components/file-menu.gts";

module("Rendering | file-menu", function (hooks) {
  setupRenderingTest(hooks);

  test("the File menu opens and lists the core actions", async function (assert) {
    await render(
      <template>
        <PortalTargets />
        <FileMenu />
      </template>,
    );

    assert.dom("button").hasText("File");

    await click("button");

    const items = [...document.querySelectorAll("[role='menu'] button, .file-menu button")]
      .map((el) => el.textContent?.trim() ?? "")
      .filter(Boolean);

    const text = items.join(" | ");

    assert.true(text.includes("New song"), `has "New song" (got: ${text})`);
    assert.true(text.includes("Open .mid file"), 'has "Open .mid file…"');
    assert.true(text.includes("Play the demo song"), 'has "Play the demo song"');
  });
});
