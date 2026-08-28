<script lang="ts">
	export let label = '';
	export let value: string | number = '';
	export let bg = 'bg-cyan-500';
</script>

<div class={`${bg} shadow-lg rounded-2xl w-36 p-4 dark:bg-gray-800`}>
	<div class="flex items-center">
		<p class="text-md text-white dark:text-white-50 ml-2">
			{label}
		</p>
	</div>
	<div class="flex flex-col justify-start">
		<p class="text-white text-2xl text-left dark:text-white font-bold my-4">
			{value}
		</p>
	</div>
</div>
