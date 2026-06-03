<script module lang="ts">
    import "$lib/styles/global.css";
    const apiEndpoint = import.meta.env.VITE_API_ENDPOINT ?? ''
</script>

<script lang="ts">
    
    let { id } = $props()
    
</script>

<div class="miniupload-container">
    <span>{id}</span>
</div>

<style>
    .miniupload-container {
        display: flex;
        justify-content: center;
        align-items: center;
        width: 10rem;
        height: 10rem;
        background: var(--color-fb-white-semi)
    }

    .miniupload-container span {
        color: black;
    }
</style>