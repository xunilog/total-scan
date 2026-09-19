import { Component, type ErrorInfo, type ReactNode } from "react";
import { Alert, Button, Code, Stack, Text, Title } from "@mantine/core";

interface ErrorBoundaryProps {
  readonly children: ReactNode;
}

interface ErrorBoundaryState {
  readonly error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("app render error", error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <Stack p="xl" gap="md">
        <Title order={2}>Une erreur est survenue</Title>
        <Text c="dimmed">
          L'application a rencontré une erreur inattendue. Rechargez la fenêtre ou réessayez.
        </Text>
        <Alert color="red" title={error.name}>
          <Code block>{error.message}</Code>
        </Alert>
        <Button w="fit-content" onClick={() => this.setState({ error: null })}>
          Réessayer
        </Button>
      </Stack>
    );
  }
}
