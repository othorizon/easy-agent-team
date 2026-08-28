import { Toaster as Sonner } from 'sonner';

function Toaster() {
  return (
    <Sonner
      position="top-center"
      richColors
      toastOptions={{
        style: { fontFamily: 'inherit' },
      }}
    />
  );
}

export { Toaster };
