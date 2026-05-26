<svelte:options customElement="datasette-share-dialog" />

<script lang="ts">
  // Scaffold stub for <datasette-share-dialog>. The real dialog (people list,
  // roles, avatars, add-box pickers, general access) lands in tasks phase-04/02–05.
  // For now this just reflects its attributes so registration can be verified.
  let {
    "resource-type": resourceType,
    parent,
    child,
    "resource-label": resourceLabel,
  } = $props<{
    "resource-type"?: string;
    parent?: string;
    child?: string;
    "resource-label"?: string;
  }>();
</script>

<div class="datasette-share-dialog">
  <p class="datasette-share-dialog__stub">datasette-share-dialog (scaffold)</p>
  <dl class="datasette-share-dialog__attrs">
    <dt>resource-type</dt>
    <dd>{resourceType ?? ""}</dd>
    <dt>parent</dt>
    <dd>{parent ?? ""}</dd>
    <dt>child</dt>
    <dd>{child ?? ""}</dd>
    {#if resourceLabel}
      <dt>resource-label</dt>
      <dd>{resourceLabel}</dd>
    {/if}
  </dl>
</div>

<style>
  .datasette-share-dialog {
    font-family:
      system-ui,
      -apple-system,
      sans-serif;
    border: 1px solid #ccc;
    border-radius: 8px;
    padding: 1rem;
    max-width: 32rem;
  }
  .datasette-share-dialog__stub {
    margin: 0 0 0.5rem;
    font-weight: 600;
  }
  .datasette-share-dialog__attrs {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.25rem 1rem;
    margin: 0;
  }
  .datasette-share-dialog__attrs dt {
    font-weight: 600;
    color: #555;
  }
  .datasette-share-dialog__attrs dd {
    margin: 0;
    font-family: ui-monospace, monospace;
  }
</style>
