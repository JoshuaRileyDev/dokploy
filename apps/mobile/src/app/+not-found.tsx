import { Redirect } from "expo-router";

// Unknown deep links land on the start screen rather than a dead end.
export default function NotFound() {
	return <Redirect href="/" />;
}
