using Godot;

public partial class Player : CharacterBody2D
{
    [Export]
    public float Speed { get; set; } = 200.0f;

    private Vector2 _velocity;

    public override void _PhysicsProcess(double delta)
    {
        Vector2 inputDir = Input.GetVector("ui_left", "ui_right", "ui_up", "ui_down");
        _velocity = inputDir * Speed;

        Velocity = _velocity;
        MoveAndSlide();

        if (inputDir.Length() > 0.1f)
        {
            GD.Print("Player is moving");
        }
    }
}
