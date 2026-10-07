// The workerd package's default export is the path to the platform binary.
declare module "workerd" {
  const binary: string;
  export default binary;
}
