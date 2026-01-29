export default function PageContainer({ children }) {
  return (
    <div className="mx-auto w-full max-w-md lg:max-w-6xl px-4 py-8">
      {children}
    </div>
  );
}
