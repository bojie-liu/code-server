import { exec } from "child_process"
import { Router } from "express"
import { promises as fs } from "fs"
import * as path from "path"
import { promisify } from "util"
import { HttpCode, HttpError } from "../../common/http"
import { rootPath } from "../constants"
import { ensureAuthenticated } from "../http"
import { paths } from "../util"

const execAsync = promisify(exec)

export const router = Router()

const VALID_TEMPLATES = ["basic-html", "vite-vanilla", "vite-vue", "vite-react"]
const PROJECTS_DIR = path.join(paths.data, "projects")

interface InitProjectRequest {
  projectId: string
  template: string
  filePath?: string // unused, kept for API compatibility
}

/**
 * Recursively copy files and directories from source to destination
 */
async function copyRecursive(src: string, dest: string): Promise<void> {
  const stat = await fs.stat(src)

  if (stat.isDirectory()) {
    await fs.mkdir(dest, { recursive: true })
    const entries = await fs.readdir(src)

    for (const entry of entries) {
      await copyRecursive(path.join(src, entry), path.join(dest, entry))
    }
  } else {
    await fs.copyFile(src, dest)
  }
}

/**
 * POST /project/init
 * Initialize a new project from a template with git repository
 */
router.post("/init", ensureAuthenticated, async (req, res) => {
  try {
    const { projectId, template } = req.body as InitProjectRequest

    // Validation
    if (!projectId || typeof projectId !== "string" || projectId.trim() === "") {
      throw new HttpError("projectId is required and must be a non-empty string", HttpCode.BadRequest)
    }

    if (!template || !VALID_TEMPLATES.includes(template)) {
      throw new HttpError(`template must be one of: ${VALID_TEMPLATES.join(", ")}`, HttpCode.BadRequest)
    }

    // Sanitize projectId (alphanumeric, hyphens, underscores only)
    const sanitizedId = projectId.replace(/[^a-zA-Z0-9-_]/g, "-")
    const projectPath = path.join(PROJECTS_DIR, sanitizedId)

    // Check if project already exists
    try {
      await fs.access(projectPath)
      throw new HttpError(`Project '${sanitizedId}' already exists`, HttpCode.BadRequest)
    } catch (err: any) {
      if (err instanceof HttpError) throw err
      if (err.code !== "ENOENT") throw err
    }

    // Create projects directory if it doesn't exist
    await fs.mkdir(PROJECTS_DIR, { recursive: true })

    // Create project directory
    await fs.mkdir(projectPath)

    // Copy template files
    const templatePath = path.join(rootPath, "src/browser/templates", template)
    try {
      await copyRecursive(templatePath, projectPath)
    } catch (err: any) {
      // Clean up project directory if template copy fails
      await fs.rm(projectPath, { recursive: true, force: true })
      throw new HttpError(`Template '${template}' not found or failed to copy: ${err.message}`, HttpCode.ServerError)
    }

    // Initialize git repository
    try {
      await execAsync("git init", { cwd: projectPath })
      await execAsync("git add .", { cwd: projectPath })
      await execAsync('git commit -m "Initial commit"', { cwd: projectPath })
      await execAsync("git tag v0.0.1", { cwd: projectPath })
    } catch (err: any) {
      // Clean up project directory if git initialization fails
      await fs.rm(projectPath, { recursive: true, force: true })
      throw new HttpError(`Failed to initialize git repository: ${err.message}`, HttpCode.ServerError)
    }

    res.json({
      success: true,
      projectId: sanitizedId,
      projectPath,
      template,
    })
  } catch (err: any) {
    if (err instanceof HttpError) {
      throw err
    }
    throw new HttpError(`Failed to initialize project: ${err.message}`, HttpCode.ServerError)
  }
})
