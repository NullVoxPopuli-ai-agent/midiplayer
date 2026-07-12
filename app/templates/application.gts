// Side-effect: pulls in nvp.ui's design tokens (variables.css / focus.css)
import "nvp.ui/button";
import "./application.css";

import { Header as UiHeader, Shell, ThemeToggle } from "nvp.ui";

import type { ComponentLike } from "@glint/template";

// nvp.ui 0.5.3's Header declares only a default block, but its template
// actually yields to :left and :right
const Header = UiHeader as unknown as ComponentLike<{
  Blocks: { left: []; right: [] };
}>;

<template>
  <Shell>
    <Header>
      <:left><strong>MIDI Player</strong></:left>
      <:right><ThemeToggle /></:right>
    </Header>

    <main class="app-main">
      {{outlet}}
    </main>
  </Shell>
</template>
