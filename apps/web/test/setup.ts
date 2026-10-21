import { configure } from "@testing-library/react";

// `findBy*` waits 1 s by default. A cold first render in a file can take longer on a loaded
// machine or CI runner, so a slow pass shouldn't read as a failure.
configure({ asyncUtilTimeout: 5_000 });
