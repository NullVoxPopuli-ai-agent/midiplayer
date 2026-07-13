// Side-effect: pulls in nvp.ui's design tokens (variables.css / focus.css)
import "nvp.ui/button";
import "./application.css";

import { PortalTargets } from "ember-primitives";
import { Header, Shell, ThemeToggle } from "nvp.ui";

<template>
  <Shell>
    <PortalTargets />
    <Header>
      <:left><strong>MIDI Player</strong></:left>
      <:right><ThemeToggle /></:right>
    </Header>

    <main class="app-main">
      {{outlet}}
    </main>
  </Shell>
</template>
